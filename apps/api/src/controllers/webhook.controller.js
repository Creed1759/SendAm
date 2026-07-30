const { sendTextMessage } = require('../services/whatsapp.service');
const { replies } = require('../services/agent/replies');
const { consume } = require('../services/rateLimit.service');
const config = require('../config/env');
const logger = require('../utils/logger');
const { enqueue } = require('../queues/queue.service');
const prisma = require('../common/prisma');

/**
 * Transport adapter for the WhatsApp Cloud API webhook. Its only jobs are
 * acknowledging the event quickly, extracting the inbound WhatsApp message,
 * and queueing background work. All conversation/payment logic lives outside
 * the webhook request path so Meta retries never duplicate money movement.
 *
 * The POST signature is verified upstream (verifyWhatsappSignature middleware).
 */
const handleIncomingMessage = async (req, res) => {
  let claimedMessageId = null;
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.status(200).send('EVENT_RECEIVED');

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || !['text', 'audio', 'voice'].includes(message.type)) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Idempotency: Meta redelivers un-acked events, so dedup on message id
    // before doing anything with side effects. A duplicate insert throws on
    // the unique index and we bail out without reprocessing.
    if (message.id) {
      try {
        await prisma.processedMessage.create({
          data: { messageId: message.id, status: 'claiming' },
        });
        claimedMessageId = message.id;
      } catch (err) {
        if (err.code === 'P2002') {
          const existing = await prisma.processedMessage.findUnique({ where: { messageId: message.id } });
          if (existing?.status === 'failed') {
            const reclaimed = await prisma.processedMessage.updateMany({
              where: { messageId: message.id, status: 'failed' },
              data: { status: 'claiming', lastError: null },
            });
            if (reclaimed.count === 1) claimedMessageId = message.id;
          }
          if (!claimedMessageId) {
            logger.info(`Skipping duplicate WhatsApp message ${message.id}`);
            // A claiming row may belong to a concurrent request. Returning a
            // retryable response prevents premature acknowledgement.
            if (existing?.status === 'claiming') return res.status(503).send('ENQUEUE_IN_PROGRESS');
            return res.status(200).send('EVENT_RECEIVED');
          }
        } else {
          throw err;
        }
      }
    }

    const from = message.from;
    const whatsappName = value?.contacts?.[0]?.profile?.name || '';

    // Per-sender throttle. We don't 429 here (that would make Meta retry and
    // flag the webhook unhealthy) — instead we drop excess messages, warning
    // the sender once at the threshold and staying quiet after that.
    const { botMax, botWindowMs } = config.rateLimit;
    const { totalHits } = await consume(`wa:${from}`, botWindowMs);
    if (totalHits > botMax) {
      logger.warn(`Throttling WhatsApp sender ${from} (${totalHits} msgs in window)`);
      if (totalHits === botMax + 1) {
        sendTextMessage(from, replies.rateLimited());
      }
      return res.status(200).send('EVENT_RECEIVED');
    }

    const options = message.id ? { jobId: message.id } : {};
    await enqueue('whatsapp-inbound', 'message.received', {
      from,
      whatsappName,
      text: message.text?.body,
      mediaId: message.audio?.id || message.voice?.id,
      messageType: message.type,
      whatsappMessageId: message.id,
    }, options);
    if (claimedMessageId) {
      await prisma.processedMessage.updateMany({
        where: { messageId: claimedMessageId, status: 'claiming' },
        data: { status: 'queued', lastError: null },
      });
    }
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    logger.error('Webhook processing error:', error);
    // Preserve a recoverable durable state. A later Meta delivery atomically
    // reclaims only failed rows; concurrent claiming/queued work is untouched.
    if (claimedMessageId) {
      try {
        await prisma.processedMessage.updateMany({
          where: { messageId: claimedMessageId, status: 'claiming' },
          data: { status: 'failed', lastError: String(error.message).slice(0, 500) },
        });
      } catch (cleanupError) {
        logger.error('Webhook delivery state recovery failed:', cleanupError);
      }
    }
    if (!res.headersSent) return res.status(503).send('QUEUE_UNAVAILABLE');
  }
};

module.exports = {
  handleIncomingMessage,
};
