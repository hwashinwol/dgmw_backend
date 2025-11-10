const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authMiddleware = require('../utils/authMiddleware'); // 인증 미들웨어

/**
 * @route   POST /api/v1/payment/checkout
 * @desc    Stripe 결제 세션 생성
 * @access  Private (로그인 필수)
 */
router.post(
    '/create-checkout-session',
    authMiddleware, // 1. (필수) 로그인한 사용자인지 검증
    paymentController.createCheckoutSession // 2. 검증 통과 시 컨트롤러 실행
);

module.exports = router;