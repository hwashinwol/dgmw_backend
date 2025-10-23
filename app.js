// 1. 필요한 패키지 가져오기
const express = require('express');
// 1-1. DB 설정 pool 가져오기
const pool = require('./config/db');
// 1-2. 라우터 파일 가져오기
const translateRoutes = require('./routes/translate.js');

// 2. Express 앱 생성
const app = express();
// 3. 서버가 실행될 포트 설정 (3000번 포트 사용)
const PORT = 3000;

// 1-2-1. 미들웨어 설정
app.use(express.json());
app.use(express.urlencoded({extended:false}));

// 1-2-2. API 라우트 연결
// '/api/v1/translate' 경로로 오는 모든 요청을 'translateRoutes' 라우터가 처리
app.use('/api/v1/translate', translateRoutes);

// 4. "Hello World" 테스트용 API
// http://localhost:3000/ 으로 접속하면 "DGMW Server is running!" 메시지를 보냄
app.get('/', (req, res) => {
    res.send('DGMW Server is running! (그런 뜻 아닌데)');
});

// 5. 서버 실행 
// 1-1-1. DB 연결 테스트
app.listen(PORT, async ()=>{
    try {
        // 서버가 시작될 때 DB 연결을 1회 테스트
        const connection = await pool.getConnection(); // pool에서 접속 하나 가져오기
        console.log('MySQL DB에 연결됨');
        connection.release(); // 사용한 접속을 pool로 반환

        console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    } catch (err) {
        // DB 연결 실패시 서버 실행을 중지할 수 있음
        console.error("MySQL 데이터베이스 연결 실패:", err.message);
    }
});
    