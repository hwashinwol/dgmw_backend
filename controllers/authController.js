const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const pool = require('../config/db'); // PM님의 DB 풀
const logger = require('../utils/logger');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Google OAuth 콜백 처리
 * 1. Google에서 'code' 받기
 * 2. 'code'를 Google 'access_token'으로 교환
 * 3. 'access_token'으로 Google 사용자 정보(id, email) 가져오기
 * 4. DB에서 user_id (Google ID)로 회원 조회
 * 5. (신규) 없으면 'free' 등급으로 DB에 INSERT (회원가입)
 * 6. (기존) 있으면 'status' 정보 로드 (로그인)
 * 7. DGMW 자체 JWT 토큰 발급
 * 8. 프론트엔드로 JWT 토큰과 함께 리다이렉트
 */
exports.googleCallback = async (req, res) => {
    const { code } = req.query;

    let db;
    try {
        // 1. Google 'code'를 'tokens' (access_token, id_token)로 교환
        //    (가이드에 따라 google-auth-library를 사용하여 더 간편하게 처리)
        db = await pool.getConnection();
        
        const { tokens } = await client.getToken(code);
        const idToken = tokens.id_token;

        // 2. id_token을 검증하여 Google 사용자 정보(payload) 획득
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        
        const googleUserId = payload['sub']; // Google의 고유 ID
        const email = payload['email'];

        if (!googleUserId || !email) {
            throw new Error('Google 사용자 정보를 가져오는 데 실패했습니다.');
        }

        // 3. DB에서 회원 조회
        const db = await pool.getConnection();
        let userStatus = 'free';
        let userId = googleUserId;

        const [rows] = await db.query('SELECT * FROM user WHERE user_id = ?', [userId]);

        if (rows.length > 0) {
            // 4. [로그인] 기존 회원
            userStatus = rows[0].status;
            logger.info(`[Auth] 기존 회원 로그인: ${email} (Status: ${userStatus})`);
        } else {
            // 5. [회원가입] 신규 회원
            logger.info(`[Auth] 신규 회원 가입: ${email}`);
            await db.query(
                'INSERT INTO user (user_id, email, status, auto_renew, created_at) VALUES (?, ?, ?, ?, NOW())',
                [userId, email, 'free', false]
            );
            // userStatus는 'free' 유지
        }

        // 6. DGMW 자체 JWT 토큰 발급 (7일 유효)
        const token = jwt.sign(
            { userId: userId, status: userStatus, email: email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // 7. 프론트엔드의 특정 콜백 페이지로 토큰을 전달하며 리다이렉트
        // (프론트엔드 /auth/callback 페이지는 URL에서 토큰을 파싱하여 localStorage에 저장해야 함)
        res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${token}`);

    } catch (error) {
        logger.error('[Auth] Google OAuth 콜백 처리 실패:', error);
        res.redirect(`${process.env.FRONTEND_URL}/auth/error?message=${error.message}`);
    } finally {
        if (db) {
            db.release();
            logger.info('[Auth] DB Connection released.');
        }
    }
};
