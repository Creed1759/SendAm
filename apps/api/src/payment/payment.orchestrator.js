const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { createQuote, validateQuoteForExecution, QUOTE_STATUS } = require('../pricing/pricing.service');
const { writeAuditLog } = require('../common/audit.service');
const { enforceTransactionPolicy } = require('../compliance/compliance.service');
const { markTransactionFailed } = require('./markFailed');
const prisma = require('../common/prisma');
const { withIdAlias } = require('../common/records');
const { assertValidAmount, percentage } = require('../utils/money');

const calculateFee = (amount, asset = 'XLM') => percentage(assertValidAmount(amount, asset), asset, 100);

const buildReceipt = ({ transaction }) => {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    amount: transaction.amount,
    asset: transaction.asset,
    rail: transaction.rail,
    receiptUrl: transaction.explorerUrl,
  };
};

// Stellar-only: every payment settles on Stellar. routeType survives as a
// compliance/reporting label computed from the countries involved.
const RAIL = 'stellar';
const NATIVE_ASSET = 'XLM';

const executePayment = async ({
  sender,
  recipientPhoneNumber,
  destination,
  amount,
  asset,
  sourceCountry = 'NG',
  destinationCountry = 'NG',
  routeType,
  // Optional: settle against a previously created quote. When omitted a fresh
  // quote is minted atomically with the payment transaction. `quoteId` is
  // validated (ownership, asset pair, amount, rate, expiration) before settle.
  quoteId,
  // Optional client idempotency key: retrying with the same key returns the
  // existing active quote/transaction instead of creating duplicates.
  idempotencyKey,
}) => {
  const senderUser = sender;
  if (!senderUser) throw new Error('Sender not found.');

  if (destination && !validateAddress(String(destination).trim())) {
    throw new Error('Destination must be a valid Stellar address.');
  }

  const rail = RAIL;
  // Direct custody only supports the native asset for now (see
  // wallet/stellar.adapter.js resolveAsset) — no anchor-asset support yet.
  const effectiveAsset = asset || NATIVE_ASSET;
  const effectiveRouteType = routeType
    || (sourceCountry && destinationCountry && sourceCountry !== destinationCountry ? 'cross_border' : 'domestic');
  const normalizedAmount = assertValidAmount(amount, effectiveAsset);

  // Core runs inside a single Prisma transaction so the quote and the payment
  // reservation commit together (or not at all). `tx` is the active transaction
  // client and must be threaded into every write — especially createQuote — so a
  // rollback cannot strand an orphan quote.
  const runCore = async (tx) => {
    const compliance = await enforceTransactionPolicy({
      user: senderUser,
      amount: normalizedAmount,
      asset: effectiveAsset,
      routeType: effectiveRouteType,
      destinationCountry,
      tx,
    });

    // Idempotency short-circuit: an earlier attempt with this key already
    // reserved a transaction. Return it (and its quote) without creating
    // duplicates or re-consuming a quote.
    if (idempotencyKey) {
      const prior = await tx.transaction.findUnique({ where: { idempotencyKey } });
      if (prior) {
        const quote = prior.quoteId ? await tx.quote.findUnique({ where: { id: prior.quoteId } }) : null;
        return { compliance, quote, transaction: prior };
      }
    }

    let quote;
    if (quoteId) {
      const existing = await tx.quote.findUnique({ where: { id: quoteId } });
      await validateQuoteForExecution({
        quote: existing,
        userId: senderUser.id,
        asset: effectiveAsset,
        amount: normalizedAmount,
      });
      // Safe to settle: claim the quote so a retry with the same id is rejected.
      quote = await tx.quote.update({
        where: { id: quoteId },
        data: { status: QUOTE_STATUS.CONSUMED },
      });
    } else {
      quote = await createQuote({
        userId: senderUser.id,
        sourceCurrency: effectiveAsset,
        targetCurrency: effectiveAsset,
        sourceAmount: normalizedAmount,
        route: rail,
        provider: rail,
        idempotencyKey,
        tx,
      });
    }

    let transaction;
    try {
      transaction = await tx.transaction.create({
        data: {
          userId: senderUser.id,
          type: 'send',
          amount: normalizedAmount,
          asset: effectiveAsset,
          recipientPhoneNumber,
          destination,
          rail,
          routeType: effectiveRouteType,
          quoteId: quote.id,
          idempotencyKey,
          status: 'processing',
          metadata: {
            fee: calculateFee(normalizedAmount, effectiveAsset),
            userHiddenRail: true,
            riskScore: compliance.riskScore,
          },
        },
      });
    } catch (error) {
      // A concurrent retry may have already reserved the transaction row by
      // the time we insert. Treat the unique violation as "already created"
      // and return the existing reservation instead of erroring.
      if (error?.code === 'P2002' && idempotencyKey) {
        const existing = await tx.transaction.findUnique({ where: { idempotencyKey } });
        if (existing) {
          const existingQuote = existing.quoteId ? await tx.quote.findUnique({ where: { id: existing.quoteId } }) : null;
          return { compliance, quote: existingQuote, transaction: existing };
        }
      }
      throw error;
    }
    return { compliance, quote, transaction };
  };

  const { quote, transaction } = await (prisma.$transaction ? prisma.$transaction(runCore) : runCore(prisma));

  // A previously reserved transaction that already settled: return it as-is
  // rather than re-submitting (prevents double-spend on client retries).
  if (transaction.status === 'success') {
    return {
      transaction: withIdAlias(transaction),
      quote,
      receipt: buildReceipt({ transaction }),
    };
  }

  let activeTransaction = transaction;

  try {
    const wallet = await walletService.createOrGetWallet({ user: senderUser });
    const result = await walletService.submitPayment({ wallet, destination, amount: normalizedAmount, asset: effectiveAsset });
    activeTransaction = await prisma.transaction.update({
      where: { id: activeTransaction.id },
      data: {
        status: 'success',
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
      },
    });

    await writeAuditLog({
      actorType: 'user',
      actorId: String(senderUser.id),
      action: 'payment.executed',
      entityType: 'Transaction',
      entityId: String(activeTransaction.id),
      metadata: { rail, status: activeTransaction.status },
    });

    return { transaction: withIdAlias(activeTransaction), quote, receipt: buildReceipt({ transaction: activeTransaction }) };
  } catch (error) {
    // Guarded: if this bookkeeping update itself rejects, the original
    // payment error is still the one thrown to the caller.
    await markTransactionFailed({
      prisma,
      transactionId: activeTransaction.id,
      metadata: activeTransaction.metadata,
      error,
    });
    throw error;
  }
};

module.exports = {
  executePayment,
  calculateFee,
  buildReceipt,
};
