const { registerProcessor } = require('../queues/queue.service');
const { processMessage } = require('../whatsapp/assistant.service');
const { processVoiceMessage } = require('../voice/voice.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const logger = require('../utils/logger');
const prisma = require('../common/prisma');

const registerWhatsAppJobs = () => {
  const worker = registerProcessor('whatsapp-inbound', async (job) => {
    const { from, whatsappName, text, mediaId, messageType, whatsappMessageId } = job.data;
    if (whatsappMessageId) {
      // This update occurs before side effects. If it fails BullMQ retries the
      // job; an API crash after enqueue can therefore still be reconciled.
      await prisma.processedMessage.update({
        where: { messageId: whatsappMessageId },
        data: { status: 'processing', lastError: null },
      });
    }

    if (messageType === 'audio' || messageType === 'voice') {
      await processVoiceMessage({ phoneNumber: from, whatsappName, mediaId, whatsappMessageId });
    } else {
      await processMessage(from, whatsappName, text);
    }

    if (whatsappMessageId) {
      try {
        await prisma.processedMessage.update({
          where: { messageId: whatsappMessageId },
          data: { status: 'completed', lastError: null },
        });
      } catch (error) {
        // Processing already completed; retrying it solely because telemetry
        // failed could duplicate replies. Leave "processing" for recovery.
        logger.error('message_delivery_completion_update_failed', {
          messageId: whatsappMessageId,
          message: error.message,
        });
      }
    }
  });

  // Bounded retry for outbound sends whose Meta status callback reported a
  // safe/transient terminal failure (see recordDeliveryStatus and
  // classifyWhatsappFailure in whatsapp.service.js). This re-send creates a
  // fresh Notification row carrying the same reference so the retry attempt
  // stays traceable back to the original transaction/voice command.
  registerProcessor('whatsapp-outbound-retry', async (job) => {
    const { recipient, body, userId, type, channel, referenceType, referenceId } = job.data;
    await sendTextMessage(recipient, body, {
      notification: { userId, type: type || 'generic', channel, referenceType, referenceId },
    });
  });

  logger.info('WhatsApp queue processor registered');
  return worker;
};

module.exports = {
  registerWhatsAppJobs,
};
