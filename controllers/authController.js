const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const pool = require('../config/db'); // PM님의 DB 풀
const logger = require('../utils/logger');

const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET, 
    `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/v1/auth/google/callback`
);

/**
 * @desc    [신규] Google OAuth 2.0 로그인 시작
 * (프론트엔드가 'Google 로그인' 버튼 클릭 시 호출)
 */

exports.googleLoginStart = (req, res) => {
    try {
        // Google 인증 페이지로 리디렉션하는 URL 생성
        const scopes = [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
        ];

        const url = client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent' // (선택) 매번 계정 선택 창을 띄움
        });

        // ⭐️ 프론트엔드에 이 URL을 json으로 보내줍니다.
        // 프론트엔드는 이 URL로 window.location.href를 변경해야 합니다.
        res.status(200).json({ authUrl: url });

    } catch (error) {
        logger.error('[Auth] Google 로그인 URL 생성 실패:', error);
        res.status(500).json({ error: '서버 오류' });
    }
};

/**
 * @desc    Google OAuth 콜백 처리
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
