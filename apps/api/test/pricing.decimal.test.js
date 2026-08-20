const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const injectMock = (relativeFromSrc, exports) => {
  const abs = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[abs] = {
    id: abs,
    filename: abs,
    loaded: true,
    exports,
  };
};

const createdQuotes = [];
const axiosGet = mock.fn();

injectMock('config/env', { pricing: { exchangeRateApiKey: 'test-key' } });
injectMock('common/prisma', {
  quote: {
    create: mock.fn(async ({ data }) => {
      createdQuotes.push(data);
      return { id: 'quote_1', ...data };
    }),
  },
});
injectMock('common/records', { withIdAlias: (record) => ({ ...record, _id: record.id }) });
require.cache[require.resolve('axios')] = {
  id: require.resolve('axios'),
  filename: require.resolve('axios'),
  loaded: true,
  exports: { get: axiosGet },
};

const { createQuote, getExchangeRate } = require('../src/pricing/pricing.service');

test('getExchangeRate returns decimal strings, including same-currency rates', async () => {
  assert.equal(await getExchangeRate({ sourceCurrency: 'USDC', targetCurrency: 'USDC' }), '1');

  axiosGet.mock.mockImplementationOnce(async () => ({ data: { conversion_rate: '1600.1234567' } }));
  assert.equal(await getExchangeRate({ sourceCurrency: 'USDC', targetCurrency: 'NGN' }), '1600.1234567');
});

test('createQuote calculates fee, net, and target amount with exact decimals', async () => {
  createdQuotes.length = 0;
  axiosGet.mock.mockImplementationOnce(async () => ({ data: { conversion_rate: '1' } }));

  const quote = await createQuote({
    userId: 'user_1',
    sourceCurrency: 'USDC',
    targetCurrency: 'USDC',
    sourceAmount: '0.30',
    route: 'stellar',
    provider: 'stellar',
  });

  assert.equal(quote.sourceAmount, '0.3000000');
  assert.equal(quote.fee, '0.0030000');
  assert.equal(quote.targetAmount, '0.2970000');
  assert.equal(createdQuotes[0].rate, '1');
});
