const pool = require('../config/db');
const logger = require('../utils/logger');
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = require('stripe')(stripeKey);

const isStripeEnabled = stripeKey && stripeKey.length > 10; 

if (isStripeEnabled) {
    logger.info('[Stripe] Stripe 결제 모듈이 [테스트 모드]로 활성화되었습니다.');
} else {
    logger.warn('[Stripe] Stripe 키가 .env에 설정되지 않았습니다. [모의 모드]로 동작합니다.');
}

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
    let db;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        logger.error(`[Webhook] 서명 검증 실패: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        db = await pool.getConnection();
        await db.beginTransaction();

        switch (event.type) {
            case 'checkout.session.completed':
            case 'invoice.payment_succeeded': {
                const session = event.data.object;
                const subscriptionId = session.subscription || (session.lines?.data[0]?.subscription);
                const customerId = session.customer;
                if (!subscriptionId) break;

                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
                const mysqlDate = currentPeriodEnd.toISOString().split('T')[0];

                await db.query(
                    `UPDATE user 
                     SET status = 'paid', 
                         stripe_subscription_id = ?, 
                         subscription_start_date = NOW(), 
                         subscription_end_date = ?, 
                         auto_renew = ? 
                     WHERE stripe_customer_id = ?`,
                    [subscriptionId, mysqlDate, true, customerId]
                );

                let userId = null;
                let paymentType = 'renewal';
                let amount = session.amount_paid;
                let transactionId = session.payment_intent;

                if (event.type === 'checkout.session.completed') {
                    userId = session.client_reference_id;
                    paymentType = 'new';
                    amount = session.amount_total;
                } else {
                    const [rows] = await db.query('SELECT user_id FROM user WHERE stripe_customer_id = ?', [customerId]);
                    userId = rows[0]?.user_id;
                }

                if (!userId) break;
                const finalAmount = amount / 100;

                await db.execute(
                    `INSERT INTO payment_history 
                     (user_id, payment_date, amount, payment_status, transaction_id, payment_type)
                     VALUES (?, NOW(), ?, ?, ?, ?)`,
                    [userId, finalAmount, 'success', transactionId, paymentType]
                );
                break;
            }

            case 'invoice.payment_failed': {
                const session = event.data.object;
                const customerId = session.customer;
                await db.query("UPDATE user SET status = 'past_due' WHERE stripe_customer_id = ?", [customerId]);
                break;
            }

            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                if (subscription.cancel_at_period_end) {
                    const customerId = subscription.customer;
                    const subscriptionEndDate = new Date(subscription.current_period_end * 1000);
                    const mysqlDate = subscriptionEndDate.toISOString().split('T')[0];
                    await db.query(
                        "UPDATE user SET auto_renew = ?, subscription_end_date = ? WHERE stripe_customer_id = ?",
                        [false, mysqlDate, customerId]
                    );
                }
                break;
            }
        }

        await db.commit();
        res.status(200).send({ received: true });

    } catch (error) {
        if (db) await db.rollback();
        logger.error('[Webhook] DB 처리 실패:', { message: error.message });
        res.status(500).json({ error: "웹훅 DB 처리 중 오류 발생" });
    } finally {
        if (db) db.release();
    }
};
