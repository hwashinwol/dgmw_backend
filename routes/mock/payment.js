// routes/mock/payment.js
// ⭐️ Stripe 키가 없을 때 사용될 '모의' 결제 라우터입니다.

const express = require('express');
const router = express.Router();
const authMiddleware = require('../../utils/authMiddleware');
const logger = require('../../utils/logger');

const mockPaymentController = {

    /**
     * @desc    [Mock] Stripe 결제 세션 생성 
     */
    createCheckoutSession: (req, res) => {
        logger.warn(`[Mock Payment] ${req.user.email} 님이 '결제 세션 생성'을 시도했습니다. (모의 모드)`);
        
        // 프론트엔드에 "모의 모드"임을 알리고 성공 처리
        res.status(200).json({
            message: "This is a mock checkout session. No real payment was made.",
            mock: true,
            // (참고) 실제 Stripe는 결제창 URL을 보냅니다.
            // url: "..." 
        });
    },

    /**
     * @desc    [Mock] Stripe 결제 재시도 (연체자)
     */
    retryPayment: (req, res) => {
        logger.warn(`[Mock Payment] ${req.user.email} 님이 '결제 재시도'를 시도했습니다. (모의 모드)`);
        res.status(200).json({
            message: "This is a mock payment retry. No real payment was made.",
            mock: true
        });
    }
};

// --- 모의 라우트 설정 ---

/**
 * @route   POST /api/v1/payment/checkout
 * @desc    [Mock] '업그레이드하기' 버튼 클릭
 * @access  Private
 */
router.post(
    '/checkout',
    authMiddleware,
    mockPaymentController.createCheckoutSession
);

/**
 * @route   POST /api/v1/payment/retry
 * @desc    [Mock] '결제 재시도' 버튼 클릭
 * @access  Private
 */
router.post(
    '/retry',
    authMiddleware,
    mockPaymentController.retryPayment
);

// (참고) /webhook 라우트는 모의 모드에서 필요하지 않습니다.

module.exports = router;