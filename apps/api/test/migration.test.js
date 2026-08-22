const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runPhoneCanonicalization } = require('../scripts/canonicalize-phone-numbers');

describe('runPhoneCanonicalization migration tool', () => {
  test('handles clean canonical rows without updates or collisions', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '+2348000000001', wallets: [{ id: 'w1' }], transactions: [], kycProfile: null },
      { id: 'u2', phoneNumber: '+2348000000002', wallets: [{ id: 'w2' }], transactions: [], kycProfile: null },
    ];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: false });

    assert.equal(report.scannedUsersCount, 2);
    assert.equal(report.alreadyCanonicalCount, 2);
    assert.equal(report.updatedUsersCount, 0);
    assert.equal(report.collisionsCount, 0);
    assert.equal(report.invalidPhoneCount, 0);
  });

  test('detects non-canonical rows and prepares updates in dry-run mode', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '08000000001', wallets: [{ id: 'w1' }], transactions: [], kycProfile: null },
      { id: 'u2', phoneNumber: '2348000000002', wallets: [{ id: 'w2' }], transactions: [], kycProfile: null },
    ];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: false });

    assert.equal(report.scannedUsersCount, 2);
    assert.equal(report.alreadyCanonicalCount, 0);
    assert.equal(report.collisionsCount, 0);
    assert.equal(report.updates.length, 2);
    assert.deepEqual(report.updates[0], {
      userId: 'u1',
      oldPhoneNumber: '08000000001',
      newPhoneNumber: '+2348000000001',
    });
    assert.deepEqual(report.updates[1], {
      userId: 'u2',
      oldPhoneNumber: '2348000000002',
      newPhoneNumber: '+2348000000002',
    });
  });

  test('applies updates to User and Wallet records when apply is true', async () => {
    const fakeUsers = [
      { id: 'u1', phoneNumber: '08000000001', wallets: [{ id: 'w1' }], transactions: [], kycProfile: null },
    ];

    const updatedUser = [];
    const updatedWallet = [];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
      $transaction: async (fn) => {
        const tx = {
          user: {
            update: async (args) => { updatedUser.push(args); },
          },
          wallet: {
            updateMany: async (args) => { updatedWallet.push(args); },
          },
        };
        return fn(tx);
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: true });

    assert.equal(report.updatedUsersCount, 1);
    assert.equal(updatedUser.length, 1);
    assert.deepEqual(updatedUser[0], {
      where: { id: 'u1' },
      data: { phoneNumber: '+2348000000001' },
    });
    assert.equal(updatedWallet.length, 1);
    assert.deepEqual(updatedWallet[0], {
      where: { userId: 'u1' },
      data: { phoneNumber: '+2348000000001' },
    });
  });

  test('flags collision and requires manual review without silently merging financial identities', async () => {
    const fakeUsers = [
      {
        id: 'u1',
        phoneNumber: '08000000001',
        wallets: [{ id: 'w1' }],
        transactions: [{ id: 't1' }],
        pinHash: 'hash1',
        kycTier: 1,
      },
      {
        id: 'u2',
        phoneNumber: '+2348000000001',
        wallets: [{ id: 'w2' }],
        transactions: [],
        pinHash: 'hash2',
        kycTier: 2,
      },
    ];

    const fakePrisma = {
      user: {
        findMany: async () => fakeUsers,
      },
    };

    const report = await runPhoneCanonicalization({ prisma: fakePrisma, apply: true });

    assert.equal(report.scannedUsersCount, 2);
    assert.equal(report.collisionsCount, 1);
    assert.equal(report.updatedUsersCount, 0);
    assert.equal(report.collisions[0].canonicalPhone, '+2348000000001');
    assert.equal(report.collisions[0].requiresManualReview, true);
    assert.equal(report.collisions[0].totalUsers, 2);
    assert.equal(report.collisions[0].financialUsersCount, 2);
  });
});
