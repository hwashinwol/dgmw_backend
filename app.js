
// 1. 필요한 패키지 가져오기
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./config/db');
const logger = require('./utils/logger');

// 1-2. 핵심 라우터 가져오기
const authRoutes = require('./routes/auth');
const translateRoutes = require('./routes/translate');
const userRouter = require('./routes/user'); // ⭐️ 수정: if문 밖으로 이동

// 2. Express 앱 생성 및 포트 설정
const app = express();
const PORT = process.env.PORT || 3000;

// --- 미들웨어 및 라우트 설정 ---

app.use(cors());

// 3. Stripe 결제 라우터 설정 (운영/모의 모드 분기)
const stripeKey = process.env.STRIPE_SECRET_KEY;
let paymentRouter; // ⭐️ 수정: paymentRouter를 미리 선언

if (stripeKey && stripeKey !== 'sk_test_...' && stripeKey.trim() !== '') {
    // --- 3-1. [운영 모드] Stripe 키가 있을 때 ---
    logger.info('[APP] Stripe 결제 라우트가 활성화되었습니다.');
    paymentRouter = require('./routes/payment');

    // ⭐️ (수정) Stripe 웹훅은 JSON 파서보다 *먼저* 등록되어야 합니다.
    app.use(
        '/api/v1/payment/webhook',
        express.raw({ type: 'application/json' }),
        paymentRouter
    );

} else {
    // --- 3-2. [모의 모드] Stripe 키가 없을 때 ---
    logger.warn('[APP] Stripe 키 없음. 결제 기능이 \'모의(Mock) 모드\'로 실행됩니다.');
    paymentRouter = require('./routes/mock/payment');
}

// 4. (필수) JSON 미들웨어
// ⭐️ (수정) 웹훅 경로 *다음에* 위치해야 합니다.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 5. 핵심 API 라우트 연결
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/translate', translateRoutes);
app.use('/api/v1/user', userRouter); // ⭐️ (수정) 항상 활성화되도록 위치 변경
app.use('/api/v1/payment', paymentRouter); // ⭐️ (수정) 운영/모의 라우터 공통 연결

// 6. "Hello World" 테스트용 API
app.get('/', (req, res) => {
    res.send('DGMW Server is running! (그런 뜻 아닌데)');
});

// 7. 서버 실행
app.listen(PORT, async () => {
    try {
    const connection = await pool.getConnection();
        logger.info('MySQL DB에 연결됨');
        connection.release();
        logger.info(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    } catch (err) {
        logger.error("MySQL 데이터베이스 연결 실패:", err.message);
    }
});