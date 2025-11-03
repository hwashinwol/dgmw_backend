const express = require('express');
const router = express.Router();
const multer = require('multer');

const {handleTranslationRequest} = require("../controllers/translateController");

// Multer 설정: 라우터 레벨에서 파일 파싱을 처리해야
// 파일 파싱은 라우터 레벨에서 처리, 컨트롤러가 req.file 객체에 접근하기 위함
const upload = multer({ 
    storage: multer.memoryStorage(),
});

/**
 * @route   POST /
 * @desc    새로운 번역 요청 (text 또는 file)
 * @access  Public / Private (토큰으로 구분)
 */

router.post(
    '/',
    upload.single('file'), // 파일 파싱
    handleTranslationRequest // 컨트롤러로 모든 req, res 객체 전달
);

// 모듈 내보내기
module.exports = router;