const ASSET_POLICIES = Object.freeze({
  XLM: { scale: 7, min: '0.0000001', max: '100000000000.0000000' },
  USDC: { scale: 7, min: '0.0000001', max: '100000000000.0000000' },
  NGN: { scale: 2, min: '0.01', max: '100000000000.00' },
  USD: { scale: 2, min: '0.01', max: '100000000000.00' },
  EUR: { scale: 2, min: '0.01', max: '100000000000.00' },
  GBP: { scale: 2, min: '0.01', max: '100000000000.00' },
});

const ROUND_HALF_UP = 'HALF_UP';
const ROUND_DOWN = 'DOWN';
const MONEY_PATTERN = /^\+?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const POW10 = Array.from({ length: 19 }, (_, i) => 10n ** BigInt(i));

const policyFor = (asset = 'XLM') => {
  const policy = ASSET_POLICIES[String(asset).toUpperCase()];
  if (!policy) throw new Error(`Unsupported asset precision policy for ${asset}.`);
  return policy;
};

const parseDecimal = (value, { scale, asset, allowExcessPrecision = false } = {}) => {
  const raw = String(value ?? '').trim();
  if (!MONEY_PATTERN.test(raw)) throw new Error('Amount must be a positive decimal string.');
  const normalized = raw.startsWith('+') ? raw.slice(1) : raw;
  const [whole, fraction = ''] = normalized.split('.');
  if (!allowExcessPrecision && scale != null && fraction.length > scale) {
    throw new Error(`${asset || 'Amount'} supports at most ${scale} decimal places.`);
  }
  const targetScale = scale ?? fraction.length;
  const padded = fraction.padEnd(targetScale, '0').slice(0, targetScale);
  return { units: BigInt(whole + padded), scale: targetScale };
};

const align = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * POW10[scale - a.scale], b.units * POW10[scale - b.scale], scale];
};

const compare = (left, right) => {
  const [a, b] = align(left, right);
  return a === b ? 0 : (a > b ? 1 : -1);
};

const formatUnits = (units, scale) => {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  if (scale === 0) return `${sign}${abs}`;
  const raw = abs.toString().padStart(scale + 1, '0');
  return `${sign}${raw.slice(0, -scale)}.${raw.slice(-scale)}`;
};

const normalizeAmount = (value, asset = 'XLM') => {
  const policy = policyFor(asset);
  const parsed = parseDecimal(value, { scale: policy.scale, asset });
  if (parsed.units <= 0n) throw new Error('Amount must be greater than zero.');
  if (compare(parsed, parseDecimal(policy.min, { scale: policy.scale })) < 0) throw new Error(`${asset} amount is below the minimum ${policy.min}.`);
  if (compare(parsed, parseDecimal(policy.max, { scale: policy.scale })) > 0) throw new Error(`${asset} amount exceeds the maximum ${policy.max}.`);
  return formatUnits(parsed.units, policy.scale);
};

const add = (left, right, scale) => {
  const [a, b, alignedScale] = align(parseDecimal(left, { allowExcessPrecision: true }), parseDecimal(right, { allowExcessPrecision: true }));
  return round({ units: a + b, scale: alignedScale }, scale);
};

const subtract = (left, right, scale) => {
  const [a, b, alignedScale] = align(parseDecimal(left, { allowExcessPrecision: true }), parseDecimal(right, { allowExcessPrecision: true }));
  return round({ units: a - b, scale: alignedScale }, scale);
};

const multiply = (left, right, scale, mode = ROUND_HALF_UP) => {
  const a = parseDecimal(left, { allowExcessPrecision: true });
  const b = parseDecimal(right, { allowExcessPrecision: true });
  return round({ units: a.units * b.units, scale: a.scale + b.scale }, scale, mode);
};

const round = (decimal, scale, mode = ROUND_HALF_UP) => {
  if (decimal.scale <= scale) return formatUnits(decimal.units * POW10[scale - decimal.scale], scale);
  const divisor = POW10[decimal.scale - scale];
  let quotient = decimal.units / divisor;
  const remainder = decimal.units % divisor;
  if (mode === ROUND_HALF_UP && remainder * 2n >= divisor) quotient += 1n;
  return formatUnits(quotient, scale);
};

module.exports = { ASSET_POLICIES, ROUND_HALF_UP, ROUND_DOWN, policyFor, parseDecimal, normalizeAmount, compare, add, subtract, multiply, round, formatUnits };
