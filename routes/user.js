const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authMiddleware = require('../utils/authMiddleware');

/**
 * @route   GET /api/v1/user/me
 * @desc    내 정보 조회 (마이페이지)
 * @access  Private
 */
router.get(
    '/me',
    authMiddleware, // 로그인한 사용자만 접근 가능
    userController.getUserMe
);

/**
 * @route   POST /api/v1/user/subscription/cancel
 * @desc    구독 취소 (자동 갱신 끄기)
 * @access  Private
 */
router.post(
    '/subscription/cancel',
    authMiddleware, // 로그인한 사용자만 접근 가능
    userController.cancelSubscription
);

/**
 * @route   DELETE /api/v1/user/
 * @desc    회원탈퇴
 * @access  Private
 */
router.delete(
    '/',
    authMiddleware, // 로그인한 사용자만 접근 가능
    userController.deleteUser
);

module.exports = router;