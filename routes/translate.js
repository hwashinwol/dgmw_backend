const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../config/db');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

// S3클라이언트 및 업로드 명령어 임포트
const s3Client = require("../config/storage");
const {PutObjectCommand} = require("@aws-sdk/client-s3");
require('dotenv').config();

// AI서비스 모듈 임포트 
const {runAnalysis} = require('../services/aiService');

// Multer 설정
// (일단 메모리에 저장하는 'memoryStorage'를 사용. 추후 Naver Storage로 바로 올릴 땐 'multer-ncloud' 등 사용)
const upload = multer({ 
    storage: multer.memoryStorage(),
    // 여기에 파일 크기 제한(limits), 파일 필터(fileFilter) 등 추가
});

/**
 * @route   POST /
 * @desc    새로운 번역 요청 (text 또는 file)
 * @access  Public / Private (토큰으로 구분)
 */

router.post(
    '/',
    upload.single('file'),
    async (req, res) => {
        const { inputType, inputText, selectedDomain } = req.body;
        const file = req.file;
        
        // inputType 필수값 검사
        if (!inputType) {
            return res.status(400).json({ error: "inputType ('text' 또는 'file') 필드는 필수입니다." });
        }
        
        // 사용자 인증 로직
        const token = req.headers.authorization;
        let userId = null; 
        let userStatus = 'free'; // 기본값 'free'
        
        if (token) {
            // (임시) 토큰이 'paid-token'이면 유료 회원으로 간주
            if (token === 'paid-token') {
                userId = null;
                userStatus = 'paid';
            }
            // (실제로는 JWT 토큰을 검증해서 userId와 status를 DB에서 조회해야 함)
        }

        // 'free' 등급 사용자는 'file' inputType을 사용할 수 없음
        if (userStatus === 'free' && inputType === 'file') {
            return res.status(403).json({ error: "파일 번역 기능은 유료 사용자 전용입니다." });
        }

        let newJobId = null;
        let textToTranslate = "";
        let finalCharCount = 0;
        let finalStoragePath = null;
        let finalInputText = null;

        try {
            // 입력 처리 및 'Translation_Job' 저장
            if (inputType === 'text') {
                // inputText 유효성 검사
                if(!inputText) {
                    return res.status(400).json({error : "inputType이 'text'일 경우 inputText 필드는 필수입니다."});
                }

                textToTranslate = inputText;
                finalCharCount = inputText.length;
                finalInputText = inputText;

                // 글자 수 제한
                if (userStatus === 'free' && finalCharCount > 5000) {
                    return res.status(413).json({ error: "텍스트 입력은 5,000자를 초과할 수 없습니다." });
                }
                if (userStatus === 'paid' && finalCharCount > 50000) {
                    return res.status(413).json({ error: "파일 입력은 50,000자를 초과할 수 없습니다." });
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

                // 글자 수 제한
                if (userStatus === 'free' && finalCharCount > 5000) {
                    return res.status(413).json({ error: "텍스트 입력은 5,000자를 초과할 수 없습니다." });
                }
                if (userStatus === 'paid' && finalCharCount > 50000) {
                    return res.status(413).json({ error: "파일 입력은 50,000자를 초과할 수 없습니다." });
                }

                // S3(NCP) 업로드
                const fileKey = `inputs/${Date.now()}-${file.originalname}.txt`;
                const command = new PutObjectCommand({
                    Bucket: process.env.NCP_BUCKET_NAME,
                    Key: fileKey,
                    Body: textToTranslate,
                    ContentType: 'text/plain; charset=utf8'
                });
                await s3Client.send(command);
                finalStoragePath = fileKey; 
            }

            // [공통] 'Translation_Job' DB에 저장
            const jobSql = `INSERT INTO Translation_Job 
                                (user_id, input_type, input_text, input_text_path, char_count, selected_domain) 
                            VALUES (?, ?, ?, ?, ?, ?)`;
            // 유료 회원일 때만 domain 저장, selectedDomain이 undefined일 경우 null로 대체
            const [jobResult] = await pool.execute(jobSql, [
                userId, 
                inputType, 
                finalInputText, 
                finalStoragePath, 
                finalCharCount, 
                (userStatus === 'paid' ? (selectedDomain || null) : null) 
            ]);
            newJobId = jobResult.insertId; 

            // AI 서비스 호출
            const aiResults = await runAnalysis(textToTranslate, userStatus);

            // 번역 결과를 'Analysis_Result' 테이블에 저장
            const resultSql = `
                INSERT INTO analysis_result 
                    (job_id, model_name, translated_text, translated_text_path, readable_score, spectrum_score)
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            // inputType에 따라 분기 처리
            if (inputType === 'text') {
                // [Text 입력] -> 번역 결과가 짧으므로 DB에 바로 저장
                for (const result of aiResults) {
                    // API 호출 실패시 DB 저장 스킵
                    if (result.error) continue;
                    await pool.execute(resultSql, [
                        newJobId,
                        result.model_name,
                        result.translated_text, // 1. DB에 텍스트 저장
                        null,                   // 2. 경로는 NULL
                        result.readable_score,
                        result.spectrum_score
                    ]);
                }
            } else if (inputType === 'file') {
                // 번역 결과가 길기 때문에 S3(NCP)에 업로드 후 경로 저장
                for (const result of aiResults) {
                    if (result.error) continue;
                    // 1. S3(NCP)에 업로드
                    const fileKey = `outputs/job-${newJobId}-${result.model_name}.txt`;
                    const command = new PutObjectCommand({
                        Bucket: process.env.NCP_BUCKET_NAME,
                        Key: fileKey,
                        Body: result.translated_text, // AI가 생성한 긴 번역문
                        ContentType: 'text/plain; charset=utf8'
                    });
                    await s3Client.send(command);

                    // 2. DB에 S3 경로 저장
                    await pool.execute(resultSql, [
                        newJobId,
                        result.model_name,
                        null,                   // 1. DB에 텍스트는 NULL
                        fileKey,                // 2. 경로는 S3 경로
                        result.readable_score,
                        result.spectrum_score
                    ]);
                }
            }

            // API 실패 결과를 제외하고 성공한 결과만 필터링하여 응답
            const successfulResults = aiResults.filter(r => !r.error);

            // 최종 응답
            res.status(201).json({
                message: "번역 작업 생성 및 AI 분석(Mock) 완료.",
                jobId: newJobId,
                userStatus: userStatus,
                inputType: inputType,
                charCount: finalCharCount,
                storagePath: finalStoragePath,
                results: aiResults // AI 결과도 함께 응답
            });

        } catch (error) {
            console.error('번역 작업 처리 중 에러 발생:', error);
            res.status(500).json({ error: "서버 내부 오류가 발생." });
        }
    }
);

// 모듈 내보내기
module.exports = router;