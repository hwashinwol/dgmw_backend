const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * 1. Stripe Checkout 세션 생성
 * (DB 커넥션 누수 방지를 위해 finally 블록 적용)
 */
exports.createCheckoutSession = async (req, res) => {
    // authMiddleware를 통과했으므로 req.user.userId가 보장됨
    const { userId, email } = req.user;
    
    let db; 

    try {
        db = await pool.getConnection(); 
        
        // DB에서 사용자의 Stripe 고객 ID 조회
        const [users] = await db.query('SELECT stripe_customer_id FROM user WHERE user_id = ?', [userId]);
        let customerId = users[0]?.stripe_customer_id;

        // Stripe 고객 ID가 없으면 (최초 결제) Stripe에 고객 생성
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: email,
                metadata: { dgmw_user_id: userId } // 우리 DB ID를 Stripe에 매핑
            });
            customerId = customer.id;
            
            // user 테이블에 stripe_customer_id 컬럼이 필요
            await db.query('UPDATE user SET stripe_customer_id = ? WHERE user_id = ?', [customerId, userId]);
        }

        // Stripe Checkout 세션 생성
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            customer: customerId, // Stripe 고객 ID
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_ID, // .env에 설정된 가격 ID
                    quantity: 1,
                },
            ],
            // client_reference_id에 우리 user_id를 넣어 웹훅에서 사용
            client_reference_id: userId,
            success_url: `${process.env.FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`,
        });

        // 프론트엔드에 결제 페이지 URL 반환
        res.json({ url: session.url });

    } catch (error) {
        logger.error('[Payment] Checkout 세션 생성 실패:', { message: error.message, stack: error.stack });
        res.status(500).json({ error: "결제 세션 생성에 실패했습니다." });
    } finally {
        if (db) {
            db.release();
            logger.info('[Payment] DB Connection released.');
        }
    }
};

/**
 * 2. Stripe Webhook 수신
 * (결제 성공 시 payment_history 테이블 INSERT 로직 추가)
 */
exports.handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        // ⭐️ 중요: req.body는 app.js에서 express.raw()로 처리된 버퍼여야 함
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        logger.error(`[Webhook] 서명 검증 실패: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const db = await pool.getConnection();
    try {
        // 이벤트 유형에 따라 처리
        switch (event.type) {
            
            // --- 1. 신규 구독 완료 / 연체 복구 완료 ---
            case 'checkout.session.completed':
            case 'invoice.payment_succeeded': {
                const session = event.data.object;
                const subscriptionId = session.subscription || (session.lines?.data[0]?.subscription);
                const customerId = session.customer;
                
                if (!subscriptionId) {
                     // 구독 ID가 없는 Webhook(예: 1회성 결제)은 무시
                    logger.info(`[Webhook] 구독 ID가 없는 이벤트 수신 (처리 건너뜀): ${event.type}`);
                    break; 
                }

                // 구독 정보 가져오기 (종료 날짜, 플랜 확인용)
                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
                
                // 1. [User 테이블] 업데이트: 'paid' 상태로 변경, 구독 ID, 종료 날짜 갱신
                await db.query(
                    `UPDATE user 
                     SET status = 'paid', 
                         stripe_subscription_id = ?, 
                         subscription_start_date = NOW(), 
                         subscription_end_date = ?, 
                         auto_renew = ? 
                     WHERE stripe_customer_id = ?`,
                    [subscriptionId, currentPeriodEnd, true, customerId]
                );
                logger.info(`[Webhook] 구독 성공: Customer ${customerId} (Status: paid)`);

                // 2. [Payment_History 테이블] 기록 
                let userId = null;
                let paymentType = 'renewal'; // 기본값 'renewal'
                let amount = session.amount_paid; // 갱신(invoice) 기준
                let transactionId = session.payment_intent;

                if (event.type === 'checkout.session.completed') {
                    // [신규 구독]
                    userId = session.client_reference_id; // createCheckoutSession에서 넣은 우리 user_id
                    paymentType = 'new';
                    amount = session.amount_total; // 신규 결제(checkout) 기준
                } else {
                    // [갱신 구독]
                    // customerId(Stripe)로 우리 user_id 조회
                    const [rows] = await db.query('SELECT user_id FROM user WHERE stripe_customer_id = ?', [customerId]);
                    userId = rows[0]?.user_id;
                }

                if (!userId) {
                    logger.error(`[Webhook] ${paymentType} 결제 건의 user_id를 찾을 수 없습니다. (Customer: ${customerId})`);
                    break;
                }
                
                // (DB 스키마: DECIMAL(10, 2))
                const finalAmount = amount / 100; // (Stripe는 센트/원이므로 100으로 나눔)

                const historySql = `
                    INSERT INTO payment_history 
                        (user_id, payment_date, amount, payment_status, transaction_id, payment_type)
                    VALUES (?, NOW(), ?, ?, ?, ?)
                `;
                await db.execute(historySql, [
                    userId,
                    finalAmount,
                    'success',
                    transactionId,
                    paymentType
                ]);
                
                logger.info(`[Webhook] 결제 내역(History) 기록 완료: User ${userId} (${paymentType})`);
                break;
            }

            // --- 2. 구독 갱신 실패 (연체 시작) ---
            case 'invoice.payment_failed': {
                const session = event.data.object;
                const customerId = session.customer;
                // DB 업데이트: 'past_due' 상태로 변경
                await db.query("UPDATE user SET status = 'past_due' WHERE stripe_customer_id = ?", [customerId]);
                logger.warn(`[Webhook] 결제 실패: Customer ${customerId} (Status: past_due)`);
                break;
            }

            // --- 3. 구독 취소 (사용자 요청 또는 Stripe에 의해) ---
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                // 사용자가 '구독 취소'(auto_renew=False) 요청 시
                if (subscription.cancel_at_period_end) {
                    const customerId = subscription.customer;
                    const subscriptionEndDate = new Date(subscription.current_period_end * 1000);
                    // DB 업데이트: 자동 갱신 끔, 종료 날짜 설정 (status는 'paid' 유지)
                    await db.query(
                        "UPDATE user SET auto_renew = ?, subscription_end_date = ? WHERE stripe_customer_id = ?",
                        [false, subscriptionEndDate, customerId]
                    );
                    logger.info(`[Webhook] 구독 취소 예약됨: Customer ${customerId}`);
                }
                break;
            }
        }
        db.release();
        res.status(200).send({ received: true });

    } catch (error) {
        db.release();
        logger.error('[Webhook] DB 처리 실패:', { message: error.message, stack: error.stack });
        res.status(500).json({ error: "웹훅 DB 처리 중 오류 발생" });
    }
};

