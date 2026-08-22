const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');
const requireRestSession = require('../middlewares/requireRestSession');

router.use(requireRestApiEnabled, requireRestSession);
router.post('/create', walletController.createWallet);
router.get('/balance', walletController.checkBalance);
router.get('/transactions', walletController.getTransactionHistory);
router.post('/send', walletController.sendFunds);
// Compatibility paths deliberately ignore the caller-supplied phone number.
router.get('/:phone/balance', walletController.checkBalance);
router.get('/:phone/transactions', walletController.getTransactionHistory);

module.exports = router;
