const logger = require('../utils/logger');
const { captureException } = require('../observability/errors');
module.exports = (err, req, res, _next) => {
  logger.error('error', { err });
  captureException(err);
  const status = err.type === 'entity.too:large' ? 413 : err.code === 'ETIMEDOUT' ? 504 : 500;
  res.status(status).json({ success: false, message: status >= 400 ? 'Request failed' : 'Server error' });
};
