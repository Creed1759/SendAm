const { test } = require('node:test');
const assert = require('node:assert/strict');

const { add, multiply, normalizeAmount } = require('../src/utils/money');
const { isValidAmount } = require('../src/utils/validators');

test('decimal addition avoids binary floating-point artifacts', () => {
  assert.equal(add('0.1', '0.2', 7), '0.3000000');
});

test('asset precision is enforced before side effects', () => {
  assert.equal(normalizeAmount('1.2345678', 'XLM'), '1.2345678');
  assert.throws(() => normalizeAmount('1.23456789', 'XLM'), /at most 7 decimal places/);
  assert.equal(isValidAmount('10.12', 'NGN'), true);
  assert.equal(isValidAmount('10.123', 'NGN'), false);
});

test('fees use deterministic half-up decimal rounding at asset scale', () => {
  assert.equal(multiply('250', '0.01', 7), '2.5000000');
  assert.equal(multiply('0.005', '1', 2), '0.01');
});

test('high value boundaries are exact', () => {
  assert.equal(normalizeAmount('100000000000.0000000', 'USDC'), '100000000000.0000000');
  assert.throws(() => normalizeAmount('100000000000.0000001', 'USDC'), /exceeds the maximum/);
});
