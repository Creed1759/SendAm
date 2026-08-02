const { registerProcessor } = require('../queues/queue.service');
const { processMessage } = require('../whatsapp/assistant.service');
const { processVoiceMessage } = require('../voice/voice.service');
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

  logger.info('WhatsApp queue processor registered');
  return worker;
};

module.exports = {
  registerWhatsAppJobs,
};
