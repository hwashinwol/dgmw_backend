const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

/**
 * @route   GET /api/v1/auth/google/callback
 * @desc    Google OAuth 2.0 콜백 처리
 * (Google 로그인 후 리다이렉트되는 경로)
 * @access  Public
 */
router.get(
    '/google',
    authController.googleLoginStart // 1. authController의 googleLoginStart 함수 실행
);


/**
 * @route   GET /api/v1/auth/google/callback
 * @desc    Google OAuth 2.0 콜백 처리
 */
router.get(
    '/google/callback',
    authController.googleCallback // 1. authController의 googleCallback 함수 실행
);

// (참고) 프론트엔드에서는 /api/v1/auth/google 같은 경로로
// 사용자를 Google 로그인 페이지로 리다이렉트시키는 로직이 필요할 수 있습니다.
// (예: res.redirect('...Google OAuth URL...'))

module.exports = router;
