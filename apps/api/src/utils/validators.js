// Lightweight request validators shared across surfaces.
// Stellar address validation lives in stellar.service (StrKey-based) so this
// module stays free of SDK concerns; import isValidPublicKey from there.

const { normalizeAmount } = require('./money');

const isValidPhoneNumber = (phone) => {
  return typeof phone === 'string' && phone.trim().length > 5;
};

const isValidAmount = (amount, asset = 'XLM') => {
  try {
    normalizeAmount(amount, asset);
    return true;
  } catch (_error) {
    return false;
  }
};

module.exports = {
  isValidPhoneNumber,
  isValidAmount,
};
