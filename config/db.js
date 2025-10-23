const mysql = require('mysql2/promise');
require('dotenv').config(); // .env 파일의 환경 변수 로드
 
// .env파일에서 읽어온 정보로 DB 연결 풀 생성
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 생성한 pool 객체 내보내기
module.exports = pool;