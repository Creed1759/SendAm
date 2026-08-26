const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcileStaleTransactions,
  listLedgerDiscrepancies,
  listStuckPayments,
  operatorResolveStuckPayment,
} = require('../src/payment/payment.reconciler');

test('reconcileStaleTransactions: updates transaction status to success when txHash is verified on Horizon', async () => {
  const updated = [];
  const prismaMock = {
    transaction: {
      findMany: async () => [
        {
          id: 'tx_100',
          status: 'processing',
          amount: '10',
          txHash: 'hash_verified_100',
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          user: { wallets: [{ publicKey: 'G_SENDER' }] },
        },
      ],
      update: async (args) => {
        updated.push(args);
        return args;
      },
    },
  };

  const horizonServerMock = {
    transactions: () => ({
      transactionHash: (hash) => ({
        call: async () => {
          if (hash === 'hash_verified_100') {
            return { successful: true };
          }
          throw { response: { status: 404 } };
        },
      }),
    }),
  };

  const result = await reconcileStaleTransactions({
    prisma: prismaMock,
    staleAgeMs: 5 * 60 * 1000,
    horizonServer: horizonServerMock,
  });

  assert.equal(result.processedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].where.id, 'tx_100');
  assert.equal(updated[0].data.status, 'success');
  assert.ok(updated[0].data.explorerUrl.includes('hash_verified_100'));
});

test('reconcileStaleTransactions: updates transaction status to success when matching payment is found in account history', async () => {
  const updated = [];
  const prismaMock = {
    transaction: {
      findMany: async () => [
        {
          id: 'tx_101',
          status: 'processing',
          amount: '25',
          destination: 'G_RECIPIENT',
          txHash: null,
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          user: { wallets: [{ publicKey: 'G_SENDER' }] },
        },
      ],
      update: async (args) => {
        updated.push(args);
        return args;
      },
    },
  };

  const horizonServerMock = {
    payments: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                {
                  type: 'payment',
                  amount: '25',
                  to: 'G_RECIPIENT',
                  transaction_hash: 'hash_from_history_101',
                },
              ],
            }),
          }),
        }),
      }),
    }),
  };

  const result = await reconcileStaleTransactions({
    prisma: prismaMock,
    staleAgeMs: 5 * 60 * 1000,
    horizonServer: horizonServerMock,
  });

  assert.equal(result.processedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(updated[0].where.id, 'tx_101');
  assert.equal(updated[0].data.status, 'success');
  assert.equal(updated[0].data.txHash, 'hash_from_history_101');
});

test('reconcileStaleTransactions: marks transaction failed when max stale age exceeded without Horizon match', async () => {
  const updated = [];
  const prismaMock = {
    transaction: {
      findMany: async () => [
        {
          id: 'tx_102',
          status: 'processing',
          amount: '50',
          txHash: 'hash_not_found',
          createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 mins old (> 3 * 5m)
          user: { wallets: [{ publicKey: 'G_SENDER' }] },
          metadata: {},
        },
      ],
      update: async (args) => {
        updated.push(args);
        return args;
      },
    },
  };

  const horizonServerMock = {
    transactions: () => ({
      transactionHash: () => ({
        call: async () => {
          throw { response: { status: 404 } };
        },
      }),
    }),
    payments: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: [] }),
          }),
        }),
      }),
    }),
  };

  const result = await reconcileStaleTransactions({
    prisma: prismaMock,
    staleAgeMs: 5 * 60 * 1000,
    horizonServer: horizonServerMock,
  });

  assert.equal(result.processedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(updated[0].where.id, 'tx_102');
  assert.equal(updated[0].data.status, 'failed');
});

test('listLedgerDiscrepancies detects unbalanced journal entries', async () => {
  const report = await listLedgerDiscrepancies({
    prisma: {
      journalEntry: {
        findMany: async () => [
          {
            id: 'entry_bad',
            eventType: 'payment.reserved',
            transactionId: 'tx_bad',
            postings: [
              { asset: 'XLM', amount: '-10.0000000' },
              { asset: 'XLM', amount: '9.0000000' },
            ],
          },
        ],
      },
    },
  });

  assert.equal(report.checkedCount, 1);
  assert.equal(report.discrepancyCount, 1);
  assert.equal(report.discrepancies[0].type, 'unbalanced_entry');
});

test('listStuckPayments returns ledger evidence and retry history', async () => {
  const result = await listStuckPayments({
    prisma: {
      transaction: {
        findMany: async () => [
          {
            id: 'tx_stuck',
            status: 'processing',
            createdAt: new Date(Date.now() - 60 * 60 * 1000),
            metadata: { retryHistory: [{ action: 'retry' }] },
            ledgerEntries: [{ id: 'entry_1', postings: [] }],
          },
        ],
      },
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].retryHistory.length, 1);
  assert.equal(result[0].ledgerEvidence.length, 1);
});

test('operatorResolveStuckPayment requires reason and records retry action without settling twice', async () => {
  await assert.rejects(() => operatorResolveStuckPayment({
    prisma: {},
    transactionId: 'tx_stuck',
    action: 'retry',
    reason: '',
    adminId: 'admin_1',
  }), /reason/);

  const updates = [];
  const prismaMock = {
    $transaction: async (fn) => fn({
      transaction: {
        findUnique: async () => ({ id: 'tx_stuck', status: 'pending', metadata: {} }),
        update: async ({ data }) => {
          updates.push(data);
          return { id: 'tx_stuck', ...data };
        },
      },
    }),
  };

  const updated = await operatorResolveStuckPayment({
    prisma: prismaMock,
    transactionId: 'tx_stuck',
    action: 'retry',
    reason: 'horizon timeout cleared',
    adminId: 'admin_1',
  });

  assert.equal(updated.status, 'processing');
  assert.equal(updates[0].metadata.retryHistory.length, 1);

  await assert.rejects(() => operatorResolveStuckPayment({
    prisma: {
      $transaction: async (fn) => fn({
        transaction: {
          findUnique: async () => ({ id: 'tx_done', status: 'success', metadata: {} }),
        },
      }),
    },
    transactionId: 'tx_done',
    action: 'retry',
    reason: 'checking duplicate',
    adminId: 'admin_1',
  }), /cannot be retried/);
});
