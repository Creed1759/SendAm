const { canonicalizePhoneNumber } = require('../src/utils/validators');

/**
 * Migration tooling for phone number canonicalization (#153).
 *
 * Scans User records, detects equivalent phone number formats, and reports
 * collisions without silently merging financial identities.
 */
const runPhoneCanonicalization = async ({ prisma, apply = false } = {}) => {
  const users = await prisma.user.findMany({
    include: {
      wallets: true,
      transactions: { take: 1 },
      kycProfile: true,
    },
  });

  const report = {
    scannedUsersCount: users.length,
    alreadyCanonicalCount: 0,
    updatedUsersCount: 0,
    invalidPhoneCount: 0,
    collisionsCount: 0,
    dryRun: !apply,
    invalidUsers: [],
    collisions: [],
    updates: [],
  };

  const canonicalGroups = new Map();

  for (const user of users) {
    let canonical;
    try {
      canonical = canonicalizePhoneNumber(user.phoneNumber);
    } catch (err) {
      report.invalidPhoneCount += 1;
      report.invalidUsers.push({
        id: user.id,
        phoneNumber: user.phoneNumber,
        error: err.message,
      });
      continue;
    }

    if (canonical === user.phoneNumber) {
      report.alreadyCanonicalCount += 1;
    }

    if (!canonicalGroups.has(canonical)) {
      canonicalGroups.set(canonical, []);
    }
    canonicalGroups.get(canonical).push({
      ...user,
      canonicalPhone: canonical,
      hasFinancialState: Boolean(
        user.wallets?.length > 0 ||
        user.transactions?.length > 0 ||
        user.pinHash ||
        user.kycProfile
      ),
    });
  }

  for (const [canonicalPhone, groupUsers] of canonicalGroups.entries()) {
    if (groupUsers.length > 1) {
      const financialUsers = groupUsers.filter((u) => u.hasFinancialState);

      report.collisionsCount += 1;
      report.collisions.push({
        canonicalPhone,
        totalUsers: groupUsers.length,
        financialUsersCount: financialUsers.length,
        requiresManualReview: true,
        users: groupUsers.map((u) => ({
          id: u.id,
          phoneNumber: u.phoneNumber,
          hasWallets: u.wallets?.length || 0,
          hasTransactions: u.transactions?.length || 0,
          hasPin: Boolean(u.pinHash),
          kycTier: u.kycTier,
        })),
      });
    } else {
      const user = groupUsers[0];
      if (user.phoneNumber !== canonicalPhone) {
        report.updates.push({
          userId: user.id,
          oldPhoneNumber: user.phoneNumber,
          newPhoneNumber: canonicalPhone,
        });
      }
    }
  }

  if (apply && report.updates.length > 0) {
    for (const update of report.updates) {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: update.userId },
          data: { phoneNumber: update.newPhoneNumber },
        });
        await tx.wallet.updateMany({
          where: { userId: update.userId },
          data: { phoneNumber: update.newPhoneNumber },
        });
      });
      report.updatedUsersCount += 1;
    }
  }

  return report;
};

const run = async () => {
  const prisma = require('../src/common/prisma');
  const apply = process.argv.includes('--apply');
  try {
    const report = await runPhoneCanonicalization({ prisma, apply });
    console.log(JSON.stringify(report, null, 2));
    if (report.collisionsCount > 0) {
      console.warn(`WARNING: ${report.collisionsCount} collision(s) detected! Manual review required.`);
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  }
};

if (require.main === module) run();

module.exports = {
  runPhoneCanonicalization,
};
