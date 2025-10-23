const express = require('express');
const router = express.Router();
const multer = require('multer');

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
    (req,res)=>{
        // 1) 요청 데이터 확인
        console.log('새 번역 요청 받음');
        console.log('Request Body (text/domain):', req.body); // inputText, inputType, selectedDomain
        console.log('Request File (file upload):', req.file); // 업로드된 파일 정보
        console.log('Auth Header (Token):', req.headers.authorization); // 인증 토큰
        console.log('---'); 

        // 2) 비즈니스 로직(이후 구현)
        // TODO: (1) 인증 토큰 검사 (user_id, status 확보)
        // TODO: (2) 'inputType'에 따라 req.body.inputText 또는 req.file 사용
        // TODO: (3) 글자 수 제한(char_count) 검사 (413 Payload Too Large)
        // TODO: (4) selectedDomain 유무에 따른 유료/무료 로직 분기 (401/402)
        // TODO: (5) (DB) Translation_Job 테이블에 작업 생성
        // TODO: (6) (AI) AI 모델 호출 + 품질 점수 계산
        // TODO: (7) (DB) Analysis_Result 테이블에 결과 저장

        // 3) 테스트용 임시 응답 
        res.status(201).json({
            message: "번역 요청 받았습니다",
            jobID: 123,
            inputType: req.body.inputType,
            fileInfo: req.file ? req.file.originalname : null
        });
    }
);

// 모듈 내보내기
module.exports = router;