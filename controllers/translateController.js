// translateController.js
const pool = require('../config/db');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const s3Client = require("../config/storage");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { runAnalysis } = require('../services/aiService'); 
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken'); 
const path = require('path');
const { getSpectrumFeedback } = require('../services/scoringService'); // feedback 함수 가져오기

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

    if (!inputType) {
        return res.status(400).json({ error: "inputType ('text' 또는 'file') 필드는 필수입니다." });
    }

    let userId = null;
    let userStatus = 'free';

    // --- 사용자 인증 ---
    try {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (token) {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                userId = decoded.userId;
                userStatus = decoded.status;
                logger.info(`[Auth/Translate] 인증된 사용자 요청: ${decoded.email} (Status: ${userStatus})`);
            }
        }
    } catch (error) {
        logger.warn(`[Auth/Translate] JWT 검증 실패: ${error.message}`);
        userId = null;
        userStatus = 'free';
    }

    // 무료 등급 사용자는 파일 입력 불가
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

        // 비회원 IP 제한
        if (!userId) {
            const ip = req.ip;
            const today = new Date().toISOString().split('T')[0];
            const usage = anonymousUsage.get(ip);

            if (usage && usage.date === today && usage.count >= 5) {
                return res.status(429).json({ error: "비회원 및 무료등급 회원은 하루 5회까지만 요청할 수 있습니다." });
            }

            const newCount = (usage && usage.date === today) ? usage.count + 1 : 1;
            anonymousUsage.set(ip, { count: newCount, date: today });
        }

        // 무료 회원 일일 5회 제한
        if (userId && userStatus === 'free') {
            const todayUsageSql = `
                SELECT COUNT(*) as usageCount
                FROM Translation_Job
                WHERE user_id = ? AND DATE(requested_at) = CURDATE()
            `;
            const [usageRows] = await db.execute(todayUsageSql, [userId]);
            if (usageRows[0].usageCount >= 5) {
                return res.status(429).json({ error: "비회원 및 무료등급 회원은 하루 5회까지만 요청할 수 있습니다." });
            }
        }

        // --- 입력 처리 ---
        if (inputType === 'text') {
            if(!inputText) return res.status(400).json({ error: "inputText 필수" });
            textToTranslate = inputText;
            finalCharCount = inputText.length;
            finalInputText = inputText;
            if (finalCharCount > 5000) return res.status(413).json({ error: "텍스트 입력은 5,000자 초과 불가" });
        } else if (inputType === 'file') {
            if (!file) return res.status(400).json({ error: "파일 업로드 필요" });

            if (file.mimetype === 'application/pdf') {
                textToTranslate = (await pdf(file.buffer)).text;
            } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                textToTranslate = (await mammoth.extractRawText({ buffer: file.buffer })).value;
            } else if (file.mimetype === 'text/plain') {
                textToTranslate = file.buffer.toString('utf8');
            } else {
                return res.status(400).json({ error: "지원하지 않는 파일 형식" });
            }

            finalCharCount = textToTranslate.length;
            if (userStatus === 'paid' && finalCharCount > 50000) {
                return res.status(413).json({ error: "파일 입력은 50,000자 초과 불가" });
            }

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

        // 도메인 매핑
        const dbDomainValue = domainMapper[selected_domain] || null;

        // --- Translation_Job 저장 ---
        const jobSql = `
            INSERT INTO Translation_Job 
                (user_id, input_type, input_text, input_text_path, char_count, selected_domain)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        const [jobResult] = await pool.execute(jobSql, [
            userId,
            inputType,
            finalInputText ?? null,
            finalStoragePath ?? null,
            finalCharCount,
            userStatus === 'paid' ? dbDomainValue : null
        ]);
        newJobId = jobResult.insertId;

        // --- AI 분석 ---
        const aiResults = await runAnalysis(textToTranslate, userStatus, selected_domain);

        // --- Analysis_Result 저장 ---
        const resultSql = `
            INSERT INTO analysis_result
                (job_id, model_name, translated_text, translated_text_path, complexity_score, spectrum_score, spectrum_feedback)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        for (const result of aiResults.filter(r => !r.error)) {
            const textValue = inputType === 'text' ? (result.translated_text ?? null) : null;
            const pathValue = inputType === 'file' ? `outputs/job-${newJobId}-${result.model_name}.txt` : null;

            // 파일 입력 시 S3 업로드
            if (inputType === 'file' && result.translated_text) {
                const fileKey = `outputs/job-${newJobId}-${result.model_name}.txt`;
                const command = new PutObjectCommand({
                    Bucket: process.env.NCP_BUCKET_NAME,
                    Key: fileKey,
                    Body: result.translated_text,
                    ContentType: 'text/plain; charset=utf8'
                });
                await s3Client.send(command);
            }

            await db.execute(resultSql, [
                newJobId,
                result.model_name,
                textValue,
                pathValue,
                result.complexity_score ?? null,
                result.spectrum_score ?? null,
                result.spectrum_feedback ?? getSpectrumFeedback(result.spectrum_score) ?? null
            ]);
        }

        res.status(201).json({
            message: "번역 작업 생성 및 AI 분석 완료.",
            jobId: newJobId,
            userStatus,
            inputType,
            charCount: finalCharCount,
            storagePath: finalStoragePath,
            selected_domain: userStatus === 'paid' ? selected_domain : null,
            results: aiResults.filter(r => !r.error)
        });

    } catch (error) {
        logger.error('번역 작업 처리 중 에러 발생:', { message: error.message, stack: error.stack });
        res.status(500).json({ error: "서버 내부 오류 발생" });
    } finally {
        if (db) {
            db.release();
            logger.info('[Translate] DB Connection released.');
        }
    }
};

module.exports = { handleTranslationRequest };
