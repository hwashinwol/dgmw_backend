const pool = require('../config/db');
const logger = require('../utils/logger');
const stripeKey = process.env.STRIPE_SECRET_KEY;
const isStripeEnabled = stripeKey && stripeKey.length > 10; 
const stripe = isStripeEnabled ? require('stripe')(stripeKey) : null;

if (isStripeEnabled) {
    logger.info('[Stripe] userController에서 Stripe 모듈을 [운영 모드]로 활성화합니다.');
} else {
    logger.warn('[Stripe] userController에서 Stripe 키가 없습니다.');
}

// DATETIME 포맷 변환
const toMySQLDateTime = (date) => {
    return date.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * @desc    내 정보 조회 (마이페이지)
 */
exports.getUserMe = async (req, res) => {
// ... (이전 코드와 동일) ...
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
        }
    }
};

/**
 * @desc    구독 취소 (자동 갱신 끄기)
 */
exports.cancelSubscription = async (req, res) => {
    const { userId, email } = req.user;
    let db;

    try {
        db = await pool.getConnection();
        await db.beginTransaction(); 
        if (isStripeEnabled) {
            // --- 1. [운영 모드] ---
            logger.info(`[User/Cancel] Stripe 모드: ${email} 님이 구독 취소를 시도합니다.`);

            const [userRows] = await db.query('SELECT stripe_subscription_id FROM user WHERE user_id = ?', [userId]);
            const subId = userRows[0]?.stripe_subscription_id;

            let mysqlDateTime = null; // 기본값 NULL

            if (subId) {
                // 2. Stripe API 호출 (갱신 중지)
                const subscription = await stripe.subscriptions.update(subId, { 
                    cancel_at_period_end: true 
                });
                logger.info(`[User/Cancel] Stripe 구독(${subId}) 갱신 중지 완료.`);

                // 3. DB 업데이트용 만료일 계산
                const periodEndTimestamp = subscription.trial_end || subscription.current_period_end;
                if (periodEndTimestamp) {
                    const endDate = new Date(periodEndTimestamp * 1000);
                    mysqlDateTime = toMySQLDateTime(endDate);
                }
            } else {
                logger.warn(`[User/Cancel] ${email}님은 Stripe 구독 ID(subId)가 없어 DB만 업데이트합니다.`);
            }
 
            // 4. DB 업데이트 
            await db.query(
                'UPDATE user SET auto_renew = ?, subscription_end_date = ? WHERE user_id = ?', 
                [false, mysqlDateTime, userId]
            );
            logger.info(`[User/Cancel] DB auto_renew = false, 만료일 = ${mysqlDateTime}로 업데이트 완료`);

        } else {
            // --- 2. [모의 모드] ---
            logger.warn(`[Mock User/Cancel] 모의 모드: ${email} 님이 구독 취소를 시도합니다.`);
            await db.query('UPDATE user SET auto_renew = ? WHERE user_id = ?', [false, userId]);
            logger.info(`[Mock User/Cancel] DB auto_renew = false로 업데이트 완료`);
        }

        await db.commit(); 
        res.status(200).json({ message: "구독 취소(자동 갱신)가 정상적으로 예약되었습니다." });

    } catch (error) {
        if (db) await db.rollback(); 
        logger.error('[User] 구독 취소 실패:', { userId, message: error.message });
        res.status(500).json({ error: "서버 오류" });
    } finally {
        if (db) db.release();
    }
};

/**
 * @desc    회원탈퇴
 */
exports.deleteUser = async (req, res) => {
    const { userId, email } = req.user;
    let db;

    try {
        db = await pool.getConnection();
        await db.beginTransaction(); // 트랜잭션 시작

        if (isStripeEnabled) {
            // 운영 모드
            logger.info(`[User/Delete] Stripe 모드: ${email} 님이 회원 탈퇴를 시도합니다.`);
            
            const [userRows] = await db.query('SELECT stripe_customer_id, stripe_subscription_id FROM user WHERE user_id = ?', [userId]);
            const customerId = userRows[0]?.stripe_customer_id;
            const subId = userRows[0]?.stripe_subscription_id;

            if (subId) {
                try {
                    // 2. (선택) 구독 즉시 취소
                    await stripe.subscriptions.cancel(subId);
                    logger.info(`[User/Delete] Stripe 구독(${subId}) 즉시 취소 완료.`);
                } catch (subErr) {
                    // 이미 취소되었거나 유효하지 않은 구독 ID일 수 있으므로, 에러를 로깅하되 탈퇴는 계속 진행
                    logger.warn(`[User/Delete] Stripe 구독(${subId}) 취소 실패 (무시하고 계속): ${subErr.message}`);
                }
            }

            if (customerId) {
                try {
                    // 3. Stripe 고객 삭제
                    await stripe.customers.del(customerId);
                    logger.info(`[User/Delete] Stripe 고객(${customerId}) 삭제 완료.`);
                } catch (custErr) {
                    logger.warn(`[User/Delete] Stripe 고객(${customerId}) 삭제 실패 (무시하고 계속): ${custErr.message}`);
                }
            }

        } else {
            // --- 2. [모의 모드] ---
            logger.warn(`[Mock User/Delete] 모의 모드: ${email} 님이 회원 탈퇴를 시도합니다.`);
        }

        // DB에서 사용자 관련 데이터 삭제 (외래 키 제약조건 순서대로)
        await db.query('DELETE FROM analysis_result WHERE job_id IN (SELECT job_id FROM translation_job WHERE user_id = ?)', [userId]);
        await db.query('DELETE FROM payment_history WHERE user_id = ?', [userId]); 
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