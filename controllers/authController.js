const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const pool = require('../config/db'); 
const logger = require('../utils/logger');

const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET, 
    `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/v1/auth/google/callback`
);

/**
 * @desc  
 */

exports.googleLoginStart = (req, res) => {
    try {
        // Google 인증 페이지로 리디렉션
        const scopes = [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
        ];

        const url = client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent' // 매번 계정선택 창 띄움
        });

        res.status(200).json({ authUrl: url });

    } catch (error) {
        logger.error('[Auth] Google 로그인 URL 생성 실패:', error);
        res.status(500).json({ error: '서버 오류' });
    }
};

/**
 * @desc   
 */
exports.googleCallback = async (req, res) => {
    const { code } = req.query;

    let db;
    try {
        db = await pool.getConnection();
        
        const { tokens } = await client.getToken(code);
        const idToken = tokens.id_token;

        // 2. Google 사용자 정보 획득
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        
        const googleUserId = payload['sub']; 
        const email = payload['email'];

        if (!googleUserId || !email) {
            throw new Error('Google 사용자 정보를 가져오는 데 실패했습니다.');
        }

        // 3. DB에서 회원 조회
        let userStatus = 'free';
        let userId = googleUserId;

        const [rows] = await db.query('SELECT * FROM user WHERE user_id = ?', [userId]);

        if (rows.length > 0) {
            // 4-1. 기존 회원 로그인
            userStatus = rows[0].status;
            logger.info(`[Auth] 기존 회원 로그인: ${email} (Status: ${userStatus})`);
        } else {
            // 4-2. 신규 회원 회원 가입
            logger.info(`[Auth] 신규 회원 가입: ${email}`);
            await db.query(
                'INSERT INTO user (user_id, email, status, auto_renew, created_at) VALUES (?, ?, ?, ?, NOW())',
                [userId, email, 'free', false]
            );
        }

        // 5. 자체 JWT 토큰 발급 (7일 유지)
        const token = jwt.sign(
            { userId: userId, status: userStatus, email: email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // 6. 프론트엔드의 콜백 페이지로 토큰 전달
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
