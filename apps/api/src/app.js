const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const webhookRoutes = require('./routes/webhook.routes');
const walletRoutes = require('./routes/wallet.routes');
const adminRoutes = require('./routes/admin.routes');
const complianceRoutes = require('./compliance/compliance.routes');
const pricingRoutes = require('./pricing/pricing.routes');
const simRoutes = require('./routes/sim.routes');
const authRoutes = require('./routes/auth.routes');
const receiptRoutes = require('./routes/receipt.routes');

const errorHandler = require('./middlewares/errorHandler');
const notFound = require('./middlewares/notFound');
const PostgresRateStore = require('./middlewares/postgresRateStore');
const config = require('./config/env');
const logger = require('./utils/logger');
const prisma = require('./common/prisma');
const { correlationMiddleware } = require('./observability/context');
const { requestMetrics, metricsHandler, increment } = require('./observability/metrics');

const app = express();

// Middlewares
app.use(correlationMiddleware);
app.use(requestMetrics);
app.use(helmet());

// CORS: in production only the configured origins may call the API. Outside
// production we fall back to open CORS for convenience, but warn if no
// allowlist is set so it isn't forgotten before launch.
if (config.corsOrigins.length > 0) {
  app.use(cors({ origin: config.corsOrigins }));
} else {
  if (config.isProduction) {
    logger.error('CORS_ORIGINS is not set in production — refusing all cross-origin requests.');
  } else {
    logger.warn('CORS_ORIGINS is not set; allowing all origins (development only).');
  }
  app.use(cors({ origin: config.isProduction ? false : true }));
}

// Access logs: the verbose, colorized 'dev' format is great locally but unfit
// for production log aggregation. Use the standard Apache 'combined' format in
// production so hosted log drains get parseable, complete request lines.
if (!config.isProduction) app.use(morgan('dev'));
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => logger.info('http_request_completed', {
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6,
  }));
  next();
});

// Server-side request timeout. Protects workers from stalled or slow requests.
const requestTimeoutMs = config.requestTimeoutMs || 30000;
app.use((req, res, next) => {
  req.setTimeout(requestTimeoutMs, () => {
    increment('sendam_request_timeouts_total', { route: req.path });
    if (!res.headersSent) {
      res.status(408).json({ error: 'request_timeout' });
    }
    req.destroy();
  });
  next();
});

// Body parsing with route-appropriate size limits. The WhatsApp webhook can
// receive media payloads, so it gets a larger limit; the rest of the API stays
// conservative. Exceeding the limit is metered and returns a safe 413.
const jsonBodyDefaults = { verify: (req, _res, buf) => { req.rawBody = buf; } };
const defaultBodyLimit = config.bodyLimit ? config.bodyLimit.api : '100kb';
const webhookBodyLimit = config.bodyLimit ? config.bodyLimit.webhook : '10mb';
const jsonParserDefault = express.json({ ...jsonBodyDefaults, limit: defaultBodyLimit });
const urlencodedParserDefault = express.urlencoded({ extended: true, limit: defaultBodyLimit });
const jsonParserWebhook = express.json({ ...jsonBodyDefaults, limit: webhookBodyLimit });
const urlencodedParserWebhook = express.urlencoded({ extended: true, limit: webhookBodyLimit });

app.use((req, res, next) => {
  const useWebhookLimit = req.path.startsWith('/webhook');
  const jsonParser = useWebhookLimit ? jsonParserWebhook : jsonParserDefault;
  const urlencodedParser = useWebhookLimit ? urlencodedParserWebhook : urlencodedParserDefault;
  jsonParser(req, res, (err) => {
    if (err) return next(err);
    urlencodedParser(req, res, next);
  });
});

// Body limit breaches are safe and observable.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    increment('sendam_body_limit_exceeded_total', { route: req.path });
    if (!res.headersSent) {
      return res.status(413).json({ error: 'payload_too_large' });
    }
  }
  next(err);
});

// Rate limiting (REST). PostgreSQL-backed store so the per-IP window is shared
// across instances. The WhatsApp webhook is throttled separately, per sender,
// in its controller — Meta proxies all events through a few IPS, so an IP
// limiter there would throttle every user together.
const limiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresRateStore(),
});
app.use('/api/', limiter);

// Prometheus scrape endpoint. It is deliberately outside the API limiter so a
// traffic spike cannot blind monitoring, and protected by a dedicated token.
app.get('/metrics', metricsHandler);

// Health check for uptime monitors and platform probes. Not rate-limited and
// requires no auth; reports 503 if the database link is down.
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw``SELECT 1``;
    increment('sendam_health_checks_total', { status: 'ok' });
    res.status(200).json({ status: 'ok', db: 'connected', uptime: process.uptime() });
  } catch (error) {
    increment('sendam_health_checks_total', { status: 'degraded' });
    logger.error('health_check_failed', error);
    res.status(503).json({ status: 'degraded', db: 'disconnected', uptime: process.uptime() });
  }
});

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/receipts', receiptRoutes);

// The REST wallet API requires a SEP-10 application session. The feature flag
// remains an operational rollout and incident-response kill switch.
if (config.features.walletRestApi) {
  if (config.isProduction) {
    logger.info('Authenticated REST wallet API enabled in production.');
  }
  app.use('/api/wallet', walletRoutes);
} else {
  logger.info('REST wallet API (/api/wallet) is disabled. Set ENABLE_WALLET_REST_API=true to enable.');
}

app.use('/api/admin', adminRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/pricing', pricingRoutes);

// The chat simulator (/api/sim/*) is an unauthenticated dev/test harness and
// must not be reachable in production by accident. Gated by ENABLE_CHAT_SIM,
// defaulting off in production — same pattern as the REST wallet API above.
if (config.features.chatSim) {
  if (config.isProduction) {
    logger.warn('ENABLE_CHAT_SIM=true in production — the unauthenticated /api/sim routes are exposed.');
  }
  app.use('/api/sim', simRoutes);
} else {
  logger.info('Chat simulator (/api/sim) is disabled. Set enable_CHAT_SIM=true to enable.');
}

// Error Handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;
