const axios = require('axios');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { assertValidAmount, percentage, convert, getAssetRule, subtract } = require('../utils/money');

const getExchangeRate = async ({ sourceCurrency = 'NGN', targetCurrency = 'USDC' }) => {
  if (sourceCurrency === targetCurrency) return '1';

  if (!config.pricing.exchangeRateApiKey) {
    return null;
  }

  const response = await axios.get(`https://v6.exchangerate-api.com/v6/${config.pricing.exchangeRateApiKey}/pair/${sourceCurrency}/${targetCurrency}`, {
    timeout: 15000,
  });
  return response.data?.conversion_rate != null ? String(response.data.conversion_rate) : null;
};

const createQuote = async ({ userId, sourceCurrency = 'NGN', targetCurrency = 'USDC', sourceAmount, route, provider }) => {
  const normalizedSourceAmount = assertValidAmount(sourceAmount, sourceCurrency);
  getAssetRule(targetCurrency);
  const rate = await getExchangeRate({ sourceCurrency, targetCurrency });
  const fee = percentage(normalizedSourceAmount, sourceCurrency, 100);
  const netSourceAmount = subtract(normalizedSourceAmount, fee, sourceCurrency);
  const targetAmount = rate ? convert({ amount: netSourceAmount, sourceAsset: sourceCurrency, targetAsset: targetCurrency, rate }) : undefined;

  const quote = await prisma.quote.create({
    data: {
    userId,
    sourceCurrency,
    targetCurrency,
    sourceAmount: normalizedSourceAmount,
    targetAmount,
    rate,
    fee,
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
