const { registerProcessor } = require('../queues/queue.service');
const { processMessage } = require('../whatsapp/assistant.service');
const { processVoiceMessage } = require('../voice/voice.service');
const { withOrdering, createInMemoryOrderingStore } = require('../queues/ordering.service');
const config = require('../config/env');
const logger = require('../utils/logger');
const prisma = require('../common/prisma');

// `orderingStore` is injectable (defaults to a fresh in-memory store) so
// tests can exercise the ordering gate directly, and so a future
// multi-process deployment can swap in a shared Redis/Postgres-backed store
// without touching this file — see apps/api/src/queues/ordering.service.js.
const registerWhatsAppJobs = ({ orderingStore = createInMemoryOrderingStore() } = {}) => {
  const processInboundMessage = async (job) => {
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
  };

  // Preserves per-customer (canonical sender) message ordering: same-sender
  // jobs run strictly in provider-timestamp order and one at a time, while
  // different senders keep the worker's full configured parallelism. See
  // apps/api/src/queues/ordering.service.js for the design.
  const orderedProcessor = withOrdering(processInboundMessage, {
    store: orderingStore,
    requeueDelayMs: config.whatsappOrdering.requeueDelayMs,
    maxRequeues: config.whatsappOrdering.maxRequeues,
  });

  const worker = registerProcessor('whatsapp-inbound', orderedProcessor);

  logger.info('WhatsApp queue processor registered');
  return worker;
};

module.exports = {
  registerWhatsAppJobs,
};
