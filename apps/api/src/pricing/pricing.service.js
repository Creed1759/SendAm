const axios = require('axios');
const config = require('../config/env');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { assertValidAmount, percentage, convert, getAssetRule, subtract, decimalToRatio } = require('../utils/money');

const normalizeCurrency = (currency) => String(currency || '').trim().toUpperCase();

const assertConfiguredCurrency = (currency) => {
  const code = normalizeCurrency(currency);
  getAssetRule(code);
  const rawConfig = config.pricing?.supportedFiatCurrencies;
  const supportedFiats = Array.isArray(rawConfig)
    ? rawConfig.map((c) => String(c).toUpperCase())
    : (typeof rawConfig === 'string' ? rawConfig.split(',').map((s) => s.trim().toUpperCase()) : ['NGN', 'USD', 'EUR', 'GBP']);
  if (!['XLM', 'USDC'].includes(code) && !supportedFiats.includes(code)) {
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
    responseType: 'text',
  });
  const rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  const match = rawText.match(/"conversion_rate"\s*:\s*([0-9.eE+-]+)/);
  if (!match || !match[1]) return null;
  return decimalToRatio(match[1]).decimal;
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
