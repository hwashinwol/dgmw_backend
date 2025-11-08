const pool = require('../config/db');
const logger = require('../utils/logger');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // 실제 운영 시 활성화 <- 지금하면 안됨?

const stripeKey = process.env.STRIPE_SECRET_KEY;
const isStripeEnabled = stripeKey && stripeKey !== 'sk_test_...' && stripeKey.trim() !== '';

/**
 * @desc    내 정보 조회 (마이페이지)
 */
exports.getUserMe = async (req, res) => {
    const { userId } = req.user;
    let db; 

    try {
        db = await pool.getConnection(); 
        const [userRows] = await db.execute(
            `SELECT user_id, email, status, subscription_start_date, subscription_end_date, auto_renew 
             FROM user 
             WHERE user_id = ?`,
            [userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
        }

        const userProfile = userRows[0];
        let usageCount = 0;
        
        if (userProfile.status === 'free') {
            const todayUsageSql = `
                SELECT COUNT(*) AS count
                FROM translation_job
                where user_id = ? AND DATE(requested_at) = CURDATE()
            `;
            const [usageRows] = await db.execute(todayUsageSql, [userId]);
            usageCount = usageRows[0].count;
        }

        const finalUserData = {
            ...userProfile,
            usageCount: usageCount
        };

        res.json(finalUserData);

    } catch (error) {
        logger.error('[User] 내 정보 조회 실패:', { userId, message: error.message });
        res.status(500).json({ error: "서버 오류" });
    } finally {
        if (db) { 
            db.release();
            logger.info('[User/Me] DB Connection released.');
        }
    }
};

/**
 * @desc    구독 취소 (자동 갱신 끄기)
 */
exports.cancelSubscription = async (req, res) => {
    const { userId, email } = req.user;
    let db;

    try {
        db = await pool.getConnection();

        if (isStripeEnabled) {
            // --- 1. [운영 모드] ---
            logger.info(`[User/Cancel] Stripe 모드: ${email} 님이 구독 취소를 시도합니다.`);
            // TODO: (Stripe 키 발급 후)
            // 1. DB에서 user.stripe_subscription_id 조회
            // 2. await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
            // 3. DB 업데이트 (auto_renew = false, subscription_end_date = ... )
            
            // (지금은 임시로 Mock 모드와 동일하게 DB만 업데이트)
            await db.query('UPDATE user SET auto_renew = ? WHERE user_id = ?', [false, userId]);
            logger.info(`[User/Cancel] (Stripe 임시) DB auto_renew = false로 업데이트 완료`);

        } else {
            // --- 2. [모의 모드] ---
            logger.warn(`[Mock User/Cancel] 모의 모드: ${email} 님이 구독 취소를 시도합니다.`);
            // DB의 auto_renew 플래그만 false로 변경
            await db.query('UPDATE user SET auto_renew = ? WHERE user_id = ?', [false, userId]);
            logger.info(`[Mock User/Cancel] DB auto_renew = false로 업데이트 완료`);
        }

        res.status(200).json({ message: "구독 취소(자동 갱신)가 정상적으로 예약되었습니다." });

    } catch (error) {
        logger.error('[User] 구독 취소 실패:', { userId, message: error.message });
        res.status(500).json({ error: "서버 오류" });
    } finally {
        if (db) db.release();
    }
};

/**
 * @desc    회원탈퇴
 */
exports.deleteUser = async (req, res) => {
    const { userId, email } = req.user;
    let db;

    try {
        db = await pool.getConnection();
        await db.beginTransaction(); // 트랜잭션 시작

        if (isStripeEnabled) {
            // --- 1. [운영 모드] ---
            logger.info(`[User/Delete] Stripe 모드: ${email} 님이 회원 탈퇴를 시도합니다.`);
            // TODO: (Stripe 키 발급 후)
            // 1. DB에서 user.stripe_customer_id 조회
            // 2. (선택) await stripe.subscriptions.cancel(subId); // 즉시 취소
            // 3. await stripe.customers.del(customerId); // Stripe 고객 삭제
            
            logger.info(`[User/Delete] (Stripe 임시) Stripe API 호출 생략`);

        } else {
            // --- 2. [모의 모드] ---
            logger.warn(`[Mock User/Delete] 모의 모드: ${email} 님이 회원 탈퇴를 시도합니다.`);
            // Stripe API 호출 없이 DB 삭제만 진행
        }

        // DB에서 사용자 관련 데이터 삭제 (외래 키 제약조건 순서대로)
        await db.query('DELETE FROM analysis_result WHERE job_id IN (SELECT job_id FROM translation_job WHERE user_id = ?)', [userId]);
        await db.query('DELETE FROM translation_job WHERE user_id = ?', [userId]);
        await db.query('DELETE FROM user WHERE user_id = ?', [userId]);

        await db.commit(); // 트랜잭션 완료
        logger.info(`[User/Delete] ${email} 회원 DB 삭제 완료`);

        res.status(200).json({ message: "회원 탈퇴가 완료되었습니다." });

    } catch (error) {
        if (db) await db.rollback(); 
        logger.error('[User] 회원 탈퇴 실패:', { userId, message: error.message });
        res.status(500).json({ error: "서버 오류" });
    } finally {
        if (db) db.release();
    }
};