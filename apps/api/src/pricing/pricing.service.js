const axios = require('axios');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { normalizeAmount, multiply, subtract, policyFor } = require('../utils/money');

const getExchangeRate = async ({ sourceCurrency = 'NGN', targetCurrency = 'USDC' }) => {
  if (sourceCurrency === targetCurrency) return '1';

  if (!config.pricing.exchangeRateApiKey) {
    return null;
  }

  const response = await axios.get(`https://v6.exchangerate-api.com/v6/${config.pricing.exchangeRateApiKey}/pair/${sourceCurrency}/${targetCurrency}`, {
    timeout: 15000,
  });
  const rate = response.data?.conversion_rate;
  return rate == null ? null : String(rate);
};

const createQuote = async ({ userId, sourceCurrency = 'NGN', targetCurrency = 'USDC', sourceAmount, route, provider }) => {
  const rate = await getExchangeRate({ sourceCurrency, targetCurrency });
  const sourcePolicy = policyFor(sourceCurrency);
  const targetPolicy = policyFor(targetCurrency);
  const normalizedSourceAmount = normalizeAmount(sourceAmount, sourceCurrency);
  const feeAmount = multiply(normalizedSourceAmount, '0.01', sourcePolicy.scale);
  const netAmount = subtract(normalizedSourceAmount, feeAmount, sourcePolicy.scale);
  const targetAmount = rate ? multiply(netAmount, rate, targetPolicy.scale) : undefined;

  const quote = await prisma.quote.create({
    data: {
      userId,
      sourceCurrency,
      targetCurrency,
      sourceAmount: normalizedSourceAmount,
      targetAmount,
      rate,
      fee: feeAmount,
      provider,
      route,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
  return withIdAlias(quote);
};

module.exports = {
  createQuote,
  getExchangeRate,
};
