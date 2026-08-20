const axios = require('axios');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { assertValidAmount, percentage, convert, getAssetRule, subtract, decimalToRatio } = require('../utils/money');

const normalizeCurrency = (currency) => String(currency || '').trim().toUpperCase();

const assertConfiguredCurrency = (currency) => {
  const code = normalizeCurrency(currency);
  getAssetRule(code);
  if (!['XLM', 'USDC'].includes(code) && !(config.pricing?.supportedFiatCurrencies || ['NGN']).includes(code)) {
    throw new Error(`Unsupported fiat currency: ${code}. Configure SUPPORTED_FIAT_CURRENCIES to enable it.`);
  }
  return code;
};

const getExchangeRate = async ({ sourceCurrency = 'NGN', targetCurrency = 'USDC' }) => {
  sourceCurrency = assertConfiguredCurrency(sourceCurrency);
  targetCurrency = assertConfiguredCurrency(targetCurrency);
  if (sourceCurrency === targetCurrency) return '1';

  if (!config.pricing?.exchangeRateApiKey) {
    return null;
  }

  const response = await axios.get(`https://v6.exchangerate-api.com/v6/${config.pricing?.exchangeRateApiKey}/pair/${sourceCurrency}/${targetCurrency}`, {
    timeout: 15000,
  });
  if (response.data?.conversion_rate == null) return null;
  return decimalToRatio(response.data.conversion_rate).decimal;
};

const createQuote = async ({ userId, sourceCurrency = 'NGN', targetCurrency = 'USDC', sourceAmount, route, provider }) => {
  sourceCurrency = assertConfiguredCurrency(sourceCurrency);
  targetCurrency = assertConfiguredCurrency(targetCurrency);
  const normalizedSourceAmount = assertValidAmount(sourceAmount, sourceCurrency);
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
  assertConfiguredCurrency,
};
