const logger = require('../utils/logger');
const { server } = require('../config/stellar');
const { getTransactionUrl } = require('../wallet/stellar.adapter');

// Reconciles stuck transactions in 'processing' or 'pending' state by querying Horizon.
const reconcileStaleTransactions = async ({
  prisma,
  staleAgeMs = 5 * 60 * 1000, // 5 minutes
  maxTransactions = 50,
  horizonServer = server,
  loggerInstance = logger,
} = {}) => {
  const cutoff = new Date(Date.now() - staleAgeMs);

  const staleTransactions = await prisma.transaction.findMany({
    where: {
      status: { in: ['processing', 'pending'] },
      createdAt: { lte: cutoff },
    },
    take: maxTransactions,
    include: {
      user: {
        include: {
          wallets: {
            where: { chain: 'stellar' },
          },
        },
      },
    },
  });

  if (staleTransactions.length === 0) {
    return { processedCount: 0, updatedCount: 0 };
  }

  let updatedCount = 0;

  for (const tx of staleTransactions) {
    try {
      // 1. Check if txHash exists and is confirmed on Horizon
      if (tx.txHash) {
        try {
          const horizonTx = await horizonServer.transactions().transactionHash(tx.txHash).call();
          if (horizonTx && horizonTx.successful) {
            await prisma.transaction.update({
              where: { id: tx.id },
              data: {
                status: 'success',
                explorerUrl: getTransactionUrl(tx.txHash),
              },
            });
            updatedCount += 1;
            loggerInstance.info(`Reconciled transaction ${tx.id} to success via txHash ${tx.txHash}`);
            continue;
          }
        } catch (err) {
          if (err.response?.status !== 404) {
            loggerInstance.warn(`Horizon error checking txHash ${tx.txHash} for tx ${tx.id}: ${err.message}`);
          }
        }
      }

      // 2. Query sender wallet's payments on Horizon if wallet address is available
      const senderPublicKey = tx.user?.wallets?.[0]?.publicKey;
      if (senderPublicKey) {
        try {
          const paymentsResponse = await horizonServer.payments().forAccount(senderPublicKey).order('desc').limit(20).call();
          const matchingPayment = paymentsResponse.records.find((p) => {
            const isPayment = p.type === 'payment';
            const amountMatches = String(p.amount) === String(tx.amount);
            const toMatches = !tx.destination || p.to === tx.destination;
            return isPayment && amountMatches && toMatches;
          });

          if (matchingPayment) {
            const hash = matchingPayment.transaction_hash;
            await prisma.transaction.update({
              where: { id: tx.id },
              data: {
                status: 'success',
                txHash: hash,
                explorerUrl: getTransactionUrl(hash),
              },
            });
            updatedCount += 1;
            loggerInstance.info(`Reconciled transaction ${tx.id} to success via payment history match on ${senderPublicKey}`);
            continue;
          }
        } catch (err) {
          loggerInstance.warn(`Horizon error checking payment history for account ${senderPublicKey}: ${err.message}`);
        }
      }

      // 3. Mark failed if stale age is exceeded (e.g. > 15 mins) and no Horizon match found
      const maxStaleCutoff = new Date(Date.now() - staleAgeMs * 3);
      if (tx.createdAt <= maxStaleCutoff) {
        await prisma.transaction.update({
          where: { id: tx.id },
          data: {
            status: 'failed',
            metadata: {
              ...tx.metadata,
              reconciliationError: 'Transaction timed out without on-chain settlement.',
            },
          },
        });
        updatedCount += 1;
        loggerInstance.info(`Reconciled stale transaction ${tx.id} to failed after timeout`);
      }
    } catch (err) {
      loggerInstance.error(`Error reconciling transaction ${tx.id}`, err.message);
    }
  }

  return { processedCount: staleTransactions.length, updatedCount };
};

const { decimalToRatio, getAssetRule } = require('../utils/money');

const canonicalizeMonetaryAmount = (amountStr, assetCode) => {
  if (amountStr == null || String(amountStr).trim() === '') return null;
  const rule = getAssetRule(assetCode);
  const ratio = decimalToRatio(amountStr);
  const factor = 10n ** BigInt(rule.precision);
  const rounded = (ratio.numerator * factor + ratio.denominator / 2n) / ratio.denominator;
  const whole = rounded / factor;
  const frac = (rounded % factor).toString().padStart(rule.precision, '0');
  return rule.precision > 0 ? `${whole}.${frac}` : `${whole}`;
};

const reconcileMonetaryValues = async ({
  prisma,
  apply = false,
  maxRecords = 1000,
  loggerInstance = logger,
} = {}) => {
  let checkedCount = 0;
  let invalidCount = 0;
  let fixedCount = 0;
  const errors = [];

  try {
    const quotes = await prisma.quote.findMany({
      take: maxRecords,
      orderBy: { createdAt: 'desc' },
    });

    for (const q of quotes) {
      checkedCount += 1;
      let needsFix = false;
      const updates = {};

      try {
        if (q.sourceAmount && q.sourceCurrency) {
          const canonical = canonicalizeMonetaryAmount(q.sourceAmount, q.sourceCurrency);
          if (canonical !== String(q.sourceAmount)) {
            needsFix = true;
            updates.sourceAmount = canonical;
          }
        }
        if (q.targetAmount && q.targetCurrency) {
          const canonical = canonicalizeMonetaryAmount(q.targetAmount, q.targetCurrency);
          if (canonical !== String(q.targetAmount)) {
            needsFix = true;
            updates.targetAmount = canonical;
          }
        }
        if (q.fee && q.sourceCurrency) {
          const canonical = canonicalizeMonetaryAmount(q.fee, q.sourceCurrency);
          if (canonical !== String(q.fee)) {
            needsFix = true;
            updates.fee = canonical;
          }
        }
        if (q.rate != null) {
          const canonicalRate = decimalToRatio(q.rate).decimal;
          if (canonicalRate !== String(q.rate)) {
            needsFix = true;
            updates.rate = canonicalRate;
          }
        }

        if (needsFix) {
          invalidCount += 1;
          if (apply) {
            await prisma.quote.update({
              where: { id: q.id },
              data: updates,
            });
            fixedCount += 1;
            loggerInstance.info(`Reconciled Quote ${q.id} monetary fields: ${JSON.stringify(updates)}`);
          }
        }
      } catch (err) {
        errors.push({ id: q.id, type: 'Quote', error: err.message });
      }
    }

    const transactions = await prisma.transaction.findMany({
      take: maxRecords,
      orderBy: { createdAt: 'desc' },
    });

    for (const tx of transactions) {
      checkedCount += 1;
      let needsFix = false;
      const updates = {};

      try {
        if (tx.amount && tx.asset) {
          const canonical = canonicalizeMonetaryAmount(tx.amount, tx.asset);
          if (canonical !== String(tx.amount)) {
            needsFix = true;
            updates.amount = canonical;
          }
        }

        if (needsFix) {
          invalidCount += 1;
          if (apply) {
            await prisma.transaction.update({
              where: { id: tx.id },
              data: updates,
            });
            fixedCount += 1;
            loggerInstance.info(`Reconciled Transaction ${tx.id} monetary fields: ${JSON.stringify(updates)}`);
          }
        }
      } catch (err) {
        errors.push({ id: tx.id, type: 'Transaction', error: err.message });
      }
    }
  } catch (err) {
    loggerInstance.error('Error during monetary reconciliation', err.message);
    errors.push({ error: err.message });
  }

  return { checkedCount, invalidCount, fixedCount, errors };
};

module.exports = { reconcileStaleTransactions, reconcileMonetaryValues };
