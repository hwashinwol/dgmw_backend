// 4. 컨트롤러 로직
// ----------------------------------------------------
const pool = require('../config/db');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const s3Client = require("../config/storage");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { runAnalysis } = require('../services/aiService'); // ⭐️ aiService(Orchestrator) 호출
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const path = require('path');

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
                
                // (중요) 토큰이 유효하면, req.user에서 userId와 status를 가져옴
                // 이 decoded 객체는 authController에서 sign했던 페이로드와 동일
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
    
    // DB에 실제 저장될 ENUM 값 (기본값 null)
    let dbDomainValue = null;

    // 유료 사용자이고, 도메인을 선택했을 때만 매핑 수행
    if (userStatus === 'paid' && selected_domain) {
        dbDomainValue = domainMapper[selected_domain];
        
        // '선택 안 함' 또는 맵핑에 없는 값이 들어온 경우 null 처리
        if (dbDomainValue === undefined) {
             dbDomainValue = null; 
        }
    }

    try {
        db = await pool.getConnection();
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
            dbDomainValue
        ]);
        newJobId = jobResult.insertId; 

        // 3. AI 서비스(Orchestrator) 호출
        // (컨트롤러는 aiService가 어떻게 동작하는지 알 필요가 없음)
        const aiResults = await runAnalysis(textToTranslate, userStatus, selected_domain);

        // 4. 번역 결과를 'Analysis_Result' 테이블에 저장
        const resultSql = `
            INSERT INTO analysis_result 
                (job_id, model_name, translated_text, translated_text_path, complexity_score, spectrum_score)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        if (inputType === 'text') {
            // [Text 입력] -> 번역 결과가 짧으므로 DB에 바로 저장
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
            // [File 입력] -> 번역 결과가 길기 때문에 S3(NCP)에 업로드
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

        // 5. 최종 응답
        const successfulResults = aiResults.filter(r => !r.error);

        res.status(201).json({
            message: "번역 작업 생성 및 AI 분석 완료.",
            jobId: newJobId,
            userStatus: userStatus,
            inputType: inputType,
            charCount: finalCharCount,
            storagePath: finalStoragePath,
            selected_domain: (userStatus === 'paid' ? selected_domain : null),
            results: successfulResults // 성공한 AI 결과만 응답
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
