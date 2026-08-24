const express = require('express');
const router = express.Router();
const controller = require('./compliance.controller');
const requireAdmin = require('../middlewares/requireAdmin');
const requireRestApiEnabled = require('../middlewares/requireRestApiEnabled');
const requireRestSession = require('../middlewares/requireRestSession');

router.get('/kyc/:phone', requireAdmin('compliance.read'), controller.getProfile);
router.get('/kyc', requireRestApiEnabled, requireRestSession, controller.getOwnProfile);
router.post('/kyc/start', requireRestApiEnabled, requireRestSession, controller.startKyc);
router.post('/kyc/callback/smileid', controller.smileIdCallback);
router.post('/kyc/:id/review', requireAdmin('compliance.write'), controller.reviewKyc);
router.post('/pin', requireRestApiEnabled, requireRestSession, controller.setPin);

module.exports = router;
