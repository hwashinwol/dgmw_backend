const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../config/db');

// 1. Multer 설정
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
    async (req,res)=>{
        // 1) 비즈니스 로직 구현하기
        const {inputType, inputText, selectedDomain} =req.body;
        const file = req.file; // 업로드된 파일
        const token = req.headers.authorization; // 인증 토큰
        // TODO: (1) 인증 토큰 검사 (user_id, status 확보)
        const userId = null; // 임시로 비회원 처리
        try {
            // TODO: (2) 'inputType'에 따라 req.body.inputText 또는 req.file 사용
            if(inputType==='text'){
                const charCount = inputText.length;
                // TODO: (3) 글자 수 제한(char_count) 검사 (413 Payload Too Large)
                if (!userId && charCount > 5000){
                    return res.status(413).json ({error: "텍스트는 5,000자를 초과할 수 없습니다."})
                }
                // TODO: (4) selectedDomain 유무에 따른 유료/무료 로직 분기 (401/402)
                // TODO: (5) (DB) Translation_Job 테이블에 작업 생성
                const sql = `
                    INSERT INTO Translation_Job 
                        (user_id, input_type, input_text, input_text_path, char_count, selected_domain)
                    VALUES 
                        (?, ?, ?, ?, ?, ?)
                `;

                // DB에 저장
                const [result] = await pool.execute(sql, [
                    userId,         
                    inputType,      
                    inputText,      // input_text (text이므로 저장)
                    null,           // input_text_path (text이므로 NULL)
                    charCount,      
                    selectedDomain || null 
                ]);
                const newJobId = result.insertId; 
                
                // TODO: (6) (AI) AI 모델 호출 + 품질 점수 계산
                // TODO: (7) (DB) Analysis_Result 테이블에 결과 저장

                // 최종 응답 로직
                res.status(201).json({
                    message: "새로운 번역 작업이 성공적으로 생성되었습니다.",
                    jobId: newJobId, 
                    inputType: inputType,
                    charCount: charCount
                });
            } else if (inputType==='file'){
                // TODO: 파일 업로드(req.file) 처리 로직 (다음 단계)
                // 1. 파일에서 텍스트 추출 (tika, pdf-parse 등)
                // 2. 글자 수 계산
                // 3. 네이버 클라우드 스토리지에 업로드
                // 4. 스토리지 경로(input_text_path)를 DB에 저장
                res.status(501).json({ error: "파일 업로드 기능은 아직 구현 중입니다." });
            }
        } catch (error) {
            // DB 에러 또는 기타 서버 에러 처리
            console.error("번역 작업 처리 중 에러 발생", error);
            res.status(500).json(({error: '서버 내부 오류가 발생했습니다'}));
        }
    }
);

// 모듈 내보내기
module.exports = router;