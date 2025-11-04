const jwt = require('jsonwebtoken');
const logger = require('./logger');

/**
 * JWT 토큰 검증 미들웨어
 * 1. 'Authorization: Bearer <token>' 헤더에서 토큰 추출
 * 2. 토큰이 유효한지 검증 (JWT_SECRET 사용)
 * 3. 유효하면, 토큰의 payload(userId, status, email)를 'req.user'에 주입
 * 4. 다음 미들웨어(컨트롤러)로 전달 (next())
 * 5. 유효하지 않으면 401 Unauthorized 에러 반환
 */
module.exports = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({ error: "인증 토큰이 필요합니다. (헤더 없음)" });
    }

    // "Bearer " 접두사 제거
    const token = authHeader.split(' ')[1]; 
    if (!token) {
        return res.status(401).json({ error: "인증 토큰 형식이 잘못되었습니다." });
    }

    try {
        // 토큰 검증
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // 검증 성공: 요청(req) 객체에 사용자 정보 주입
        req.user = decoded; // (e.g., req.user.userId, req.user.status)
        
        // 다음 미들웨어(컨트롤러)로 제어권 넘김
        next();

    } catch (error) {
        logger.warn(`[Auth] JWT 토큰 검증 실패: ${error.message}`);
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: "토큰이 만료되었습니다. 다시 로그인해주세요." });
        }
        return res.status(401).json({ error: "유효하지 않은 토큰입니다." });
    }
};

