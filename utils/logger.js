const winston = require('winston');
const {combine, timestamp, printf, colorize} = winston.format;

// 로그 포맷 정의
const logFormat = printf(({level, message, timestamp})=>{
    return `${timestamp} ${level}: ${message}`;
});

const logger = winston.createLogger({
    format: combine(
        colorize(),
        timestamp({format: "YYYY-MM-DD HH:mm:ss"}),
        logFormat
    ),
    transports: [
        // 콘솔에 로그 출력
        new winston.transports.Console({
            level: 'info',
        }),
        // 파일에 에러 로그 저장
        new winston.transports.File({
            level: 'error',
            filename: 'logs/error.log',
            format: combine(
                timestamp({format:'YYYY-MM-DD HH:mm:ss'}),
                logFormat
            )
        })
    ]
});

module.exports=logger;