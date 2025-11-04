exports.getUserMe = async (req, res) => {
    const { userId } = req.user;
    let db; 

    try {
        db = await pool.getConnection(); 
        const [rows] = await db.query(
            `SELECT user_id, email, status, subscription_start_date, subscription_end_date, auto_renew 
             FROM user 
             WHERE user_id = ?`,
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
        }
        res.json(rows[0]);

    } catch (error) {
        logger.error('[User] 내 정보 조회 실패:', { userId, message: error.message, stack: error.stack });
        res.status(500).json({ error: "서버 오류" });
    } finally {
        if (db) { 
            db.release();
            logger.info('[User/Me] DB Connection released.');
        }
    }
};