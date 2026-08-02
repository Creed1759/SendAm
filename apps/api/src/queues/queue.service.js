const config = require('../config/env');
const logger = require('../utils/logger');

let Queue;
let Worker;
let IORedis;
let connection;

try {
  ({ Queue, Worker } = require('bullmq'));
  IORedis = require('ioredis');
  connection = config.redis.url ? new IORedis(config.redis.url, { maxRetriesPerRequest: null }) : undefined;
  connection?.on('error', (error) => logger.error('queue_redis_error', { message: error.message }));
} catch (_error) {
  logger.warn('BullMQ is not installed; webhook jobs will run inline in development.');
}

const inlineProcessors = new Map();
const queues = new Map();
const workers = new Map();

const getQueue = (name) => {
  if (!Queue || !connection) return null;
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection }));
  return queues.get(name);
};

const registerProcessor = (name, processor) => {
  inlineProcessors.set(name, processor);
  if (Queue && Worker && connection) {
    if (workers.has(name)) return workers.get(name);
    const worker = new Worker(name, processor, {
      connection,
      concurrency: config.worker.concurrency,
      lockDuration: config.worker.lockDurationMs,
    });
    worker.on('completed', (job) => logger.info('queue_job_completed', { queue: name, jobId: job.id, jobName: job.name }));
    worker.on('failed', (job, error) => logger.error('queue_job_failed', {
      queue: name,
      jobId: job?.id,
      jobName: job?.name,
      attemptsMade: job?.attemptsMade,
      message: error.message,
    }));
    worker.on('error', (error) => logger.error('queue_worker_error', { queue: name, message: error.message }));
    workers.set(name, worker);
    return worker;
  }
  return null;
};

const enqueue = async (name, jobName, data, options = {}) => {
  const queue = getQueue(name);
  if (queue) {
    return queue.add(jobName, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
      ...options,
    });
  }

  const processor = inlineProcessors.get(name);
  if (processor) {
    setImmediate(() => processor({ name: jobName, data }).catch((error) => {
      logger.error(`Inline job ${name}:${jobName} failed`, error.message);
    }));
    return { id: options.jobId || `inline-${Date.now()}` };
  }
  throw new Error(`Queue "${name}" is unavailable: configure REDIS_URL and run the worker process`);
};

const closeQueues = async () => {
  await Promise.all([...workers.values()].map((worker) => worker.close()));
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  workers.clear();
  queues.clear();
  inlineProcessors.clear();
  if (connection) await connection.quit();
};

module.exports = {
  enqueue,
  registerProcessor,
  closeQueues,
};
