const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * 1. Stripe Checkout 세션 생성
 * - '구독 플랜' 모달에서 '업그레이드하기' 버튼 클릭 시 호출
 * - 'past_due' 상태에서 '결제 재시도' 버튼 클릭 시 호출
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
            
            // ⭐️ 중요: PM님의 user 테이블에 stripe_customer_id 컬럼이 필요합니다.
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
 * - Stripe가 결제 성공/실패/취소 등 모든 이벤트를 이 엔드포인트로 전송
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
                
                if (subscriptionId) {
                    // 구독 정보 가져오기 (종료 날짜 확인용)
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
                    
                    // DB 업데이트: 'paid' 상태로 변경, 구독 ID, 종료 날짜 갱신
                    // ⭐️ 중요: PM님의 user 테이블에 stripe_subscription_id 컬럼이 필요합니다.
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

                    // TODO: 결제 내역(payment_history) 테이블에 기록 (PM님 DB 스키마 참조)
                    // ... (INSERT INTO payment_history ...)
                }
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

