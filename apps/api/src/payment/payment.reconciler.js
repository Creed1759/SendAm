const logger = require('../utils/logger');
const { server } = require('../config/stellar');
const { getTransactionUrl } = require('../wallet/stellar.adapter');

// Stellar transactions are built with setTimeout(30), meaning the network
// will reject the envelope if it isn't included within ~30 ledger-closes
// (~2.5 minutes at 5s/ledger). We give a generous buffer beyond that before
// treating a missing hash as definitively expired.
const LEDGER_SEQUENCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes — safely beyond setTimeout(30)

// A Horizon 404 for a txHash that was submitted recently can simply mean the
// ledger hasn't propagated to the node we hit yet (ingestion lag). We only
// treat the 404 as conclusive once the ledger sequence window has closed.
const isLedgerSequenceExpired = (tx, nowMs = Date.now()) => {
  return (new Date(tx.createdAt).getTime() + LEDGER_SEQUENCE_WINDOW_MS) < nowMs;
};

// Reconciles stuck transactions in 'processing' or 'pending' state by querying Horizon.
// Finality policy:
//   confirmed  → Horizon reports txHash present in a closed ledger (successful=true)
//   expired    → txHash 404 AND ledger sequence window has closed
//   pending    → txHash 404 but window still open (transient ingestion lag — retry next cycle)
//   failed     → definitive Horizon failure response OR exceeded max stale age
const reconcileStaleTransactions = async ({
  prisma,
  staleAgeMs = 5 * 60 * 1000, // 5 minutes
  maxTransactions = 50,
  horizonServer = server,
  loggerInstance = logger,
  onReceipt = null, // optional callback(tx) called when a tx transitions to success
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
      // 1. If we have a txHash, verify it on Horizon before anything else.
      if (tx.txHash) {
        let horizonTx = null;
        let notFound = false;

        try {
          horizonTx = await horizonServer.transactions().transactionHash(tx.txHash).call();
        } catch (err) {
          if (err.response?.status === 404) {
            notFound = true;
          } else {
            loggerInstance.warn(`Horizon error checking txHash ${tx.txHash} for tx ${tx.id}: ${err.message}`);
          }
        }

        if (horizonTx && horizonTx.successful) {
          // ✅ Confirmed — ledger-backed finality achieved.
          const updated = await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              status: 'success',
              explorerUrl: getTransactionUrl(tx.txHash),
              metadata: {
                ...tx.metadata,
                confirmedAt: new Date().toISOString(),
              },
            },
          });
          updatedCount += 1;
          loggerInstance.info(`Reconciled transaction ${tx.id} to success via txHash ${tx.txHash}`);

          // Issue the customer receipt now that finality is confirmed.
          if (onReceipt) {
            try { await onReceipt(updated); } catch (e) { loggerInstance.warn(`Receipt callback failed for tx ${tx.id}: ${e.message}`); }
          }
          continue;
        }

        if (horizonTx && !horizonTx.successful) {
          // ❌ Definitive on-chain failure (e.g. op_underfunded recorded on ledger).
          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              status: 'failed',
              metadata: {
                ...tx.metadata,
                reconciliationError: 'Transaction included in ledger but marked unsuccessful.',
                failedAt: new Date().toISOString(),
              },
            },
          });
          updatedCount += 1;
          loggerInstance.info(`Reconciled transaction ${tx.id} to failed — ledger marked unsuccessful`);
          continue;
        }

        if (notFound) {
          if (!isLedgerSequenceExpired(tx)) {
            // ⏳ 404 but the ledger sequence window is still open — this is a
            // transient ingestion delay, not a failure. Leave as pending and
            // retry on the next reconciliation cycle.
            loggerInstance.info(`Transaction ${tx.id} txHash ${tx.txHash} returned 404 — ledger window still open, will retry`);
            continue;
          }

          // ❌ 404 + window closed = ledger sequence definitively expired.
          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              status: 'expired',
              metadata: {
                ...tx.metadata,
                reconciliationError: 'ledger_sequence_expired',
                expiredAt: new Date().toISOString(),
              },
            },
          });
          updatedCount += 1;
          loggerInstance.info(`Reconciled transaction ${tx.id} to expired — txHash not found after ledger sequence window closed`);
          continue;
        }
      }

      // 2. No txHash: query sender wallet payment history on Horizon.
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
            const updated = await prisma.transaction.update({
              where: { id: tx.id },
              data: {
                status: 'success',
                txHash: hash,
                explorerUrl: getTransactionUrl(hash),
                metadata: {
                  ...tx.metadata,
                  confirmedAt: new Date().toISOString(),
                },
              },
            });
            updatedCount += 1;
            loggerInstance.info(`Reconciled transaction ${tx.id} to success via payment history match on ${senderPublicKey}`);

            if (onReceipt) {
              try { await onReceipt(updated); } catch (e) { loggerInstance.warn(`Receipt callback failed for tx ${tx.id}: ${e.message}`); }
            }
            continue;
          }
        } catch (err) {
          loggerInstance.warn(`Horizon error checking payment history for account ${senderPublicKey}: ${err.message}`);
        }
      }

      // 3. No Horizon match found. Only mark failed after the maximum stale
      //    age AND the ledger sequence window is confirmed closed — never on
      //    wall-clock alone if the window could still be open.
      const maxStaleCutoff = new Date(Date.now() - staleAgeMs * 3);
      if (tx.createdAt <= maxStaleCutoff && isLedgerSequenceExpired(tx)) {
        await prisma.transaction.update({
          where: { id: tx.id },
          data: {
            status: 'failed',
            metadata: {
              ...tx.metadata,
              reconciliationError: 'ledger_sequence_expired',
              failedAt: new Date().toISOString(),
            },
          },
        });
        updatedCount += 1;
        loggerInstance.info(`Reconciled stale transaction ${tx.id} to failed — ledger sequence expired, no on-chain evidence`);
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
