// 4. 컨트롤러 로직 (신규)
const pool = require('../config/db');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const s3Client = require("../config/storage");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { runAnalysis } = require('../services/aiService'); 
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken'); 
const path = require('path'); 

// 비회원 IP 기반 사용량 추적기 (서버 재시작 시 초기화)
const anonymousUsage = new Map();

const domainMapper = {
    '선택 안 함': null,
    '공학': 'engineering',
    '사회과학': 'social_science',
    '예술': 'art',
    '의료': 'medical',
    '법률': 'law',
    '자연과학': 'nature_science',
    '인문학': 'humanities'
};

/**
 * @route   POST /
 * @desc    새로운 번역 요청 (text 또는 file)
 * @access  Public / Private (토큰으로 구분)
 */
const handleTranslationRequest = async (req, res) => {
    const { inputType, inputText, selected_domain } = req.body;
    const file = req.file;
    
    // inputType 필수값 검사
    if (!inputType) {
        return res.status(400).json({ error: "inputType ('text' 또는 'file') 필드는 필수입니다." });
    }
    // --- 사용자 인증 로직 ---
    
    let userId = null;
    let userStatus = 'free';

    try {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (token) {
                // 토큰 검증
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                
                // 토큰이 유효하면, req.user에서 userId와 status를 가져옴
                userId = decoded.userId;
                userStatus = decoded.status;
                logger.info(`[Auth/Translate] 인증된 사용자 요청: ${decoded.email} (Status: ${userStatus})`);
            }
        }
    } catch (error) {
        logger.warn(`[Auth/Translate] JWT 검증 실패 (free 등급 처리): ${error.message}`);
        userId = null;
        userStatus = 'free';
    }
    // --- 인증 로직 종료 ---

    // 'free' 등급 사용자는 'file' inputType을 사용할 수 없음
    if (userStatus === 'free' && inputType === 'file') {
        return res.status(403).json({ error: "파일 번역 기능은 유료 사용자 전용입니다." });
    }

    let newJobId = null;
    let textToTranslate = "";
    let finalCharCount = 0;
    let finalStoragePath = null;
    let finalInputText = null;

    let db;

    try {
        db = await pool.getConnection();

        // 비회원 제한 로직
        if (!userId) {
            const ip = req.ip; 
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const usage = anonymousUsage.get(ip);

            if (usage && usage.date === today && usage.count >= 5) {
                logger.warn(`[Usage Limit] 비회원 IP 일일 사용량 초과. IP: ${ip}`);
                return res.status(429).json({ error: "비회원 및 무료등급 회원은 하루에 5회까지만 요청할 수 있습니다." });
            }

            // 비회원 카운트 업데이트 또는 신규 등록 (성공 시에만)
            const newCount = (usage && usage.date === today) ? usage.count + 1 : 1;
            anonymousUsage.set(ip, { count: newCount, date: today });
            logger.info(`[Usage] 비회원 IP 사용량 증가. IP: ${ip}, Count: ${newCount}`);
        }

        // 무료 회원 일일 5회 제한 로직
        // 서버시간은 KST 기준
        if (userId && userStatus === 'free') {
            const todayUsageSql = `
                SELECT COUNT(*) as usageCount
                FROM Translation_Job
                WHERE user_id = ? AND DATE(requested_at) = CURDATE()
            `;
            const [usageRows] = await db.execute(todayUsageSql, [userId]);
            const usageCount = usageRows[0].usageCount;

            if (usageCount >= 5) {  
                logger.warn(`[Usage Limit] 무료 사용자 일일 사용량 초과. UserID: ${userId} (Count: ${usageCount})`);
                return res.status(429).json({ error: "비회원 및 무료등급 회원은 하루에 5회까지만 요청할 수 있습니다." });
            }
        }

        // 1. 입력 처리 (Text or File)
        if (inputType === 'text') {
            if(!inputText) {
                return res.status(400).json({error : "inputType이 'text'일 경우 inputText 필드는 필수입니다."});
            }
            textToTranslate = inputText;
            finalCharCount = inputText.length;
            finalInputText = inputText;

            // 글자 수 제한 (텍스트는 5000자)
            if (finalCharCount > 5000) {
                return res.status(413).json({ error: "텍스트 입력은 5,000자를 초과할 수 없습니다." });
            }
            
        } else if (inputType === 'file') {
            if (!file) return res.status(400).json({ error: "파일이 업로드되지 않았습니다." });

            // 텍스트 추출
            if (file.mimetype === 'application/pdf') {
                textToTranslate = (await pdf(file.buffer)).text;
            } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                textToTranslate = (await mammoth.extractRawText({ buffer: file.buffer })).value;
            } else if (file.mimetype === 'text/plain') {
                textToTranslate = file.buffer.toString('utf8');
            } else {
                return res.status(400).json({ error: "지원하지 않는 파일 형식입니다. (pdf, docx, txt만 가능)" });
            }
            
            finalCharCount = textToTranslate.length;

            // 글자 수 제한 (파일은 50000자)
            if (userStatus === 'paid' && finalCharCount > 50000) {
                return res.status(413).json({ error: "파일 입력은 50,000자를 초과할 수 없습니다." });
            }

            // S3(NCP) 업로드
            
            const originalnameUtf8 = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const originalBasename = path.parse(originalnameUtf8).name;
            const fileKey = `inputs/${Date.now()}-${originalBasename}.txt`;

            const command = new PutObjectCommand({
                Bucket: process.env.NCP_BUCKET_NAME,
                Key: fileKey,
                Body: textToTranslate,
                ContentType: 'text/plain; charset=utf8'
            });
            await s3Client.send(command);
            finalStoragePath = fileKey; 
        }

        // 한글 도메인 -> 영어 ENUM 값으로 매핑
        const dbDomainValue = domainMapper[selected_domain] || null;

        // 2. 'Translation_Job' DB에 저장
        const jobSql = `INSERT INTO Translation_Job 
                            (user_id, input_type, input_text, input_text_path, char_count, selected_domain) 
                        VALUES (?, ?, ?, ?, ?, ?)`;
        const [jobResult] = await pool.execute(jobSql, [
            userId, 
            inputType, 
            finalInputText, // text 입력 시 본문, file 입력 시 null
            finalStoragePath, // file 입력 시 S3 경로, text 입력 시 null
            finalCharCount, 
            (userStatus === 'paid' ? dbDomainValue : null) // 매핑된 값 저장
        ]);
        newJobId = jobResult.insertId; 

        // 3. AI 서비스(Orchestrator) 호출
        const aiResults = await runAnalysis(textToTranslate, userStatus, selected_domain); 

        // 4. 번역 결과를 'Analysis_Result' 테이블에 저장
        const resultSql = `
            INSERT INTO analysis_result 
                (job_id, model_name, translated_text, translated_text_path, complexity_score, spectrum_score)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        if (inputType === 'text') {
            for (const result of aiResults) {
                if (result.error) continue;
                await pool.execute(resultSql, [
                    newJobId,
                    result.model_name,
                    result.translated_text, // 1. DB에 텍스트 저장
                    null,                   // 2. 경로는 NULL
                    result.complexity_score,
                    result.spectrum_score
                ]);
            }
        } else if (inputType === 'file') {
            // 파일 입력 -> 번역 결과가 길기 때문에 S3(NCP)에 업로드
            for (const result of aiResults) {
                if (result.error) continue;
                
                const fileKey = `outputs/job-${newJobId}-${result.model_name}.txt`;
                const command = new PutObjectCommand({
                    Bucket: process.env.NCP_BUCKET_NAME,
                    Key: fileKey,
                    Body: result.translated_text,
                    ContentType: 'text/plain; charset=utf8'
                });
                await s3Client.send(command);

                await db.execute(resultSql, [
                    newJobId,
                    result.model_name,
                    null,                   // 1. DB에 텍스트는 NULL
                    fileKey,                // 2. 경로는 S3 경로
                    result.complexity_score,
                    result.spectrum_score
                ]);
            }
        }

        const successfulResults = aiResults.filter(r => !r.error);

        res.status(201).json({
            message: "번역 작업 생성 및 AI 분석 완료.",
            jobId: newJobId,
            userStatus: userStatus,
            inputType: inputType,
            charCount: finalCharCount,
            storagePath: finalStoragePath,
            selected_domain: (userStatus === 'paid' ? selected_domain : null),
            results: successfulResults 
        });

    } catch (error) {
        logger.error('번역 작업 처리 중 에러 발생:', { 
            message: error.message, 
            stack: error.stack,
            body: req.body
        });
        res.status(500).json({ error: "서버 내부 오류가 발생." });
    } finally {
        if (db) {
            db.release();
            logger.info('[Translate] DB Connection released.');
        }
    }
};

module.exports = { handleTranslationRequest };