// 1. 필요한 패키지 가져오기
const express = require('express');
const pool = require('./config/db');
const logger = require('./utils/logger'); 

// 1-2. 라우터 파일 가져오기
const authRoutes = require('./routes/auth');
const translateRoutes = require('./routes/translate');
const paymentRouter = require('./routes/payment');
const userRouter = require('./routes/user');

// 2. Express 앱 생성
const app = express();
// 3. 서버가 실행될 포트 설정 (3000번 포트 사용)
const PORT = process.env.PORT || 3000; // (수정) .env 포트 우선 사용

// --- 미들웨어 및 라우트 설정 (순서가 매우 중요합니다!) ---

// ⭐️ (필수) 1. Stripe 웹훅 전용 미들웨어
// /webhook 경로는 express.json()보다 *반드시* 먼저 와야 합니다.
// 이 라우트만 raw body(버퍼)를 사용하도록 설정합니다.
app.use(
    '/api/v1/payment/webhook', // ⭐️ payment.js 안의 /webhook 경로와 일치
    express.raw({ type: 'application/json' }),
    paymentRouter // ⭐️ 웹훅 라우트가 포함된 paymentRouter를 여기서 먼저 연결
);

// (필수) 2. 나머지 API를 위한 JSON 미들웨어
// Stripe 웹훅을 제외한 모든 요청은 JSON으로 파싱합니다.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// (필수) 3. API 라우트 연결
app.use('/api/v1/auth', authRoutes); // (추가) /api/v1/auth 경로 담당
app.use('/api/v1/translate', translateRoutes); // /api/v1/translate 경로 담당
app.use('/api/v1/payment', paymentRouter); // (수정) /webhook을 제외한 /payment 경로(/checkout) 담당
app.use('/api/v1/user', userRouter); // (수정) /api/v1/user 경로 담당

// 4. "Hello World" 테스트용 API
app.get('/', (req, res) => {
    res.send('DGMW Server is running! (그런 뜻 아닌데)');
});

// 5. 서버 실행 
app.listen(PORT, async () => {
    try {
        // 서버가 시작될 때 DB 연결을 1회 테스트
        const connection = await pool.getConnection();
        logger.info('MySQL DB에 연결됨'); // (수정) console.log 대신 logger 사용
        connection.release(); // 사용한 접속을 pool로 반환

        logger.info(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    } catch (err) {
        logger.error("MySQL 데이터베이스 연결 실패:", err.message);
    }
});
