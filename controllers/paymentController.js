const pool = require('../config/db');
const logger = require('../utils/logger');
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = require('stripe')(stripeKey);

const isStripeEnabled = stripeKey && stripeKey.length > 10; 

if (isStripeEnabled) {
    logger.info('[Stripe] Stripe 결제 모듈이 [테스트 모드]로 활성화되었습니다.');
} else {
    logger.warn('[Stripe] Stripe 키가 .env에 설정되지 않았습니다'); 
}

const toMySQLDateTime = (date) => {
    return date.toISOString().slice(0, 19).replace('T', ' ');
};

exports.createCheckoutSession = async (req, res) => {
    const { userId, email } = req.user;
    const priceId = process.env.STRIPE_PRICE_ID;
    const frontendUrl = process.env.FRONTEND_URL;

    let db; 

    try {
        db = await pool.getConnection(); 
        
        const [users] = await db.query('SELECT stripe_customer_id FROM user WHERE user_id = ?', [userId]);
        let customerId = users[0]?.stripe_customer_id;

        if (!customerId) {
            const customer = await stripe.customers.create({
                email: email,
                metadata: { dgmw_user_id: userId }
            });
            customerId = customer.id;
            await db.query('UPDATE user SET stripe_customer_id = ? WHERE user_id = ?', [customerId, userId]);
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            customer: customerId,
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            client_reference_id: userId,
            success_url: `${frontendUrl}/?payment_success=true`,
            cancel_url: `${frontendUrl}/?payment_canceled=true`,
        });

        res.json({ url: session.url });

    } catch (error) {
        logger.error('[Payment] Checkout 세션 생성 실패:', { message: error.message });
        res.status(500).json({ error: "결제 세션 생성에 실패했습니다." });
    } finally {
        if (db) db.release();
    }
};

exports.handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        logger.error(`[Webhook] ❌ 서명 검증 실패: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    let db;
    try {
        db = await pool.getConnection();
        await db.beginTransaction(); 

        switch (event.type) {
            
            // --- 최초 결제(구독) 완료 ---
            // [최종 수정] 이 이벤트는 '유저 상태'만 업데이트
            // (결제 내역 INSERT 로직 완전 삭제 
            case 'checkout.session.completed': {
                const session = event.data.object;
                const subscriptionId = session.subscription;
                const userId = session.client_reference_id; 
                
                if (!subscriptionId || !userId) {
                    logger.error(`[Webhook] checkout.session.completed에 subscriptionId 또는 userId가 없습니다.`);
                    break; 
                }

                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                const periodEndTimestamp = subscription.trial_end || subscription.current_period_end;
                
                let mysqlDateTime = null; 
                if (periodEndTimestamp) {
                    const currentPeriodEnd = new Date(periodEndTimestamp * 1000);
                    if (isNaN(currentPeriodEnd.getTime())) { throw new Error("Date object is invalid."); }
                    mysqlDateTime = toMySQLDateTime(currentPeriodEnd);
                } else {
                    logger.warn(`[Webhook] 'trial_end'와 'current_period_end'가 모두 없습니다. subscription_end_date를 NULL로 설정합니다.`);
                }
                
                // User 테이블의 상태/날짜만 업데이트
                await db.query(
                    `UPDATE user 
                     SET status = 'paid', 
                         stripe_subscription_id = ?, 
                         subscription_start_date = NOW(), 
                         subscription_end_date = ?, 
                         auto_renew = ? 
                     WHERE user_id = ?`,
                    [subscriptionId, mysqlDateTime, true, userId]
                );
                
                logger.info(`[Webhook] checkout.session.completed (User: ${userId}) [유저 상태] 업데이트 완료.`);
                break;
            }

            // --- [2] 결제 성공 (최초 또는 갱신) ---
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                const customerId = invoice.customer;
                const subscriptionId = invoice.subscription;
                
                if (!subscriptionId || !customerId) {
                    logger.warn(`[Webhook] ℹ️ invoice.payment_succeeded에 subscriptionId/customerId가 없습니다. (비표준 플랜 추정). 건너뜁니다.`);
                    break;
                }
                
                // 결제 금액이 0보다 클 때만 '결제 내역(History)' INSERT
                const finalAmount = invoice.amount_paid / 100;
                
                if (finalAmount > 0) {
                    // Customer ID로 User ID 찾기
                    const [rows] = await db.query('SELECT user_id FROM user WHERE stripe_customer_id = ?', [customerId]);
                    if (rows.length === 0) {
                        logger.error(`[Webhook] CustomerID ${customerId}에 해당하는 유저를 찾지 못했습니다.`);
                        break; // 롤백 없이 이 이벤트만 중단
                    }
                    const userId = rows[0].user_id;

                    const transactionId = invoice.payment_intent; 
                    if (!transactionId) {
                        logger.error(`[Webhook] 유료 결제(Amount: ${finalAmount})인데 payment_intent가 없습니다. 롤백합니다.`);
                        throw new Error('Paid invoice is missing transactionId (payment_intent)');
                    }

                    // billing_reason으로 신규/갱신 구분
                    const paymentType = (invoice.billing_reason === 'subscription_create') ? 'new' : 'renewal';

                    await db.execute(
                        `INSERT INTO payment_history 
                          (user_id, payment_date, amount, payment_status, transaction_id, payment_type)
                         VALUES (?, NOW(), ?, ?, ?, ?)`,
                        [userId, finalAmount, 'success', transactionId, paymentType]
                    );
                    
                    logger.info(`[Webhook] ✅ invoice.payment_succeeded (User: ${userId}) [결제 내역] 기록 완료.`);

                    // 갱신 시 유저의 다음 결제일 업데이트
                    if (paymentType === 'renewal') {
                        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                        const periodEndTimestamp = subscription.current_period_end;
                        if (periodEndTimestamp) {
                            const currentPeriodEnd = new Date(periodEndTimestamp * 1000);
                            const mysqlDateTime = toMySQLDateTime(currentPeriodEnd);
                            await db.query(
                                `UPDATE user SET subscription_end_date = ?, status = 'paid', auto_renew = ? WHERE user_id = ?`,
                                [mysqlDateTime, true, userId]
                            );
                            logger.info(`[Webhook] ℹ️ (갱신) User ${userId}의 다음 결제일 업데이트 완료.`);
                        }
                    }
                } else {
                     logger.info(`[Webhook] ℹ️ invoice.payment_succeeded (Amount: 0)은 결제 내역을 기록하지 않습니다.`);
                }
                break;
            }

            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                if (subscription.cancel_at_period_end) { 
                    const customerId = subscription.customer;
                    const periodEndTimestamp = subscription.trial_end || subscription.current_period_end;
                    let mysqlDateTime = null; 
                    if (periodEndTimestamp) {
                        const subscriptionEndDate = new Date(periodEndTimestamp * 1000);
                        if (isNaN(subscriptionEndDate.getTime())) { throw new Error("Date object is invalid."); }
                        mysqlDateTime = toMySQLDateTime(subscriptionEndDate);
                    } else {
                         logger.warn(`[Webhook] ℹ️ customer.subscription.updated: 날짜가 없습니다. (무료 플랜 추정) subscription_end_date를 NULL로 설정합니다.`);
                    }
                    await db.query(
                        "UPDATE user SET auto_renew = ?, subscription_end_date = ? WHERE stripe_customer_id = ?",
                        [false, mysqlDateTime, customerId]
                    );
                    logger.info(`[Webhook] ℹ️ customer.subscription.updated (Customer: ${customerId}) - 구독 취소됨.`);
                }
                break;
            }
            case 'invoice.payment_failed': {
                const customerId = event.data.object.customer;
                await db.query("UPDATE user SET status = 'past_due' WHERE stripe_customer_id = ?", [customerId]);
                logger.warn(`[Webhook] invoice.payment_failed (Customer: ${customerId})`);
                break;
            }

            default:
                logger.info(`[Webhook] 처리되지 않은 이벤트: ${event.type}`);
        }

        await db.commit();
        logger.info(`[Webhook] Transaction Committed for event ${event.type}.`);
        res.status(200).send({ received: true });

    } catch (error) {
        logger.error(`[Webhook] DB 처리 실패 (Event: ${event.type}):`, error); 
        
        if (db) {
            try {
                await db.rollback();
                logger.info('[Webhook] Transaction Rolled Back.');
            } catch (rollBackError) {
                logger.error('[Webhook] 롤백 실패:', rollBackError);
            }
        }
        
        res.status(500).json({ error: "Webhook DB 처리 중 오류 발생" });
    
    } finally {
        if (db) {
            db.release();
        }
    }
};