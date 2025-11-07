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

// /**
//  * @route   POST /api/v1/payment/webhook
//  * @desc    Stripe 웹훅 수신
//  * @access  Public (Stripe 서버가 직접 호출)
//  */
// router.post(
//     '/webhook',
//     // (중요) 인증 미들웨어(authMiddleware)가 없어야 합니다.
//     express.raw({type : 'application/json'}),
//     paymentController.handleStripeWebhook
// );

module.exports = router;