const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const walletService = require('../wallet/wallet.service');
const { validateAddress } = require('../wallet/stellar.adapter');
const { executePayment } = require('../payment/payment.orchestrator');
const { verifyPin } = require('../compliance/pin.service');
const { sendTextMessage } = require('../services/whatsapp.service');
const { claimPendingSend } = require('./pendingClaim');
const { createRecipientResolver } = require('./recipientResolver');
const prisma = require('../common/prisma');
const { canonicalizePhoneNumber } = require('../utils/validators');

const PENDING_SEND_TTL_MS = 10 * 60 * 1000;
const NATIVE_ASSET = 'XLM';

const resolveUser = async (phoneNumber, whatsappName) => {
  const canonicalPhone = canonicalizePhoneNumber(phoneNumber);
  let user = await prisma.user.findUnique({ where: { phoneNumber: canonicalPhone } });
  if (!user) {
    user = await prisma.user.create({ data: { phoneNumber: canonicalPhone, whatsappName } });
  } else if (whatsappName && user.whatsappName !== whatsappName) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { whatsappName },
    });
  }
  return user;
};

const parsePaymentIntent = (text) => {
  const normalized = String(text || '').trim();
  const memoMatch = normalized.match(/(?:\bwith\s+memo\b|\bmemo\b)(?::|\s+)?(?:(text|id|hash|return):)?\s*([^\s]+)/i);
  let memo;
  let memoType;
  let textWithoutMemo = normalized;
  if (memoMatch) {
    memoType = memoMatch[1] ? memoMatch[1].toLowerCase() : 'text';
    memo = memoMatch[2];
    textWithoutMemo = normalized.replace(memoMatch[0], '').trim();
  }

  const sendMatch = textWithoutMemo.match(
    /(?:send|pay|transfer)\s+([\d.]+)\s*((?!to\b)[a-zA-Z]{2,5})?\s+(?:to\s+)?(.+)/i
  );
  if (!sendMatch) return null;
  return {
    amount: sendMatch[1],
    asset: sendMatch[2] ? sendMatch[2].toUpperCase() : NATIVE_ASSET,
    recipient: sendMatch[3].trim(),
    ...(memo ? { memo, memoType } : {}),
  };
};

// Precedence: saved contacts → phone numbers → raw address passthrough. See
// recipientResolver.js; the address-validity check in requestConfirmation
// still applies to whatever comes back.
const resolveRecipient = createRecipientResolver({ prisma, walletService });

const requestConfirmation = async ({ phoneNumber, user, intent, notify }) => {
  const recipient = await resolveRecipient(user, intent.recipient);

  if (!validateAddress(String(recipient.destination || '').trim())) {
    await notify(
      phoneNumber,
      `"${recipient.label}" isn't a saved contact or a valid Stellar address. Save it first, or send to a valid address directly.`
    );
    return;
  }

  // Detect first-time, changed, or high-risk destination
  const previousTx = await prisma.transaction.findFirst({
    where: {
      userId: user.id,
      destination: recipient.destination,
      status: 'success',
    },
  });

  const isSavedContact = await prisma.alias.findFirst({
    where: {
      userId: user.id,
      target: recipient.destination,
    },
  });

  const isFirstTime = !previousTx;
  const isHighRisk = isFirstTime && !isSavedContact;

  const addressStr = String(recipient.destination).trim();
  const fingerprint = `SDA-FP-${crypto.createHash('sha256').update(addressStr).digest('hex').slice(0, 8).toUpperCase()}`;

  const pendingSend = {
    amount: intent.amount,
    asset: intent.asset,
    destination: recipient.destination,
    alias: recipient.label,
    memo: intent.memo,
    memoType: intent.memoType,
    routeType: 'domestic',
    requestedAt: new Date(),
    isHighRisk,
    highRiskConfirmed: false,
    fingerprint,
  };
  await prisma.user.update({
    where: { id: user.id },
    data: { pendingSend },
  });

  if (isHighRisk) {
    const warnMsg = `⚠️ HIGH-RISK RECIPIENT DETECTED\nYou have never sent money to this address before:\nFingerprint: ${fingerprint}\n\nDo you trust this recipient? Reply "YES" to confirm, or "NO" to cancel.`;
    await notify(phoneNumber, warnMsg);
  } else {
    let confirmMsg = `Please confirm this payment:\nAmount: ${intent.amount} ${intent.asset}\nTo: ${recipient.label}`;
    if (intent.memo) {
      confirmMsg += `\nMemo (${intent.memoType || 'text'}): ${intent.memo}`;
    }
    confirmMsg += `\nReply with your PIN to send, or "no" to cancel.`;
    await notify(phoneNumber, confirmMsg);
  }
};

const handlePendingPin = async ({ phoneNumber, user, text, notify }) => {
  if (!user.pendingSend?.destination) return false;

  const lowered = String(text).trim().toLowerCase();
  if (lowered === 'no' || lowered === 'cancel') {
    // Json? columns need Prisma.DbNull — a plain null in `data` throws at runtime.
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: Prisma.DbNull } });
    await notify(phoneNumber, 'Payment cancelled.');
    return true;
  }

  if (Date.now() - new Date(user.pendingSend.requestedAt).getTime() > PENDING_SEND_TTL_MS) {
    await prisma.user.update({ where: { id: user.id }, data: { pendingSend: Prisma.DbNull } });
    await notify(phoneNumber, 'That payment request expired. Please start again.');
    return true;
  }

  // Intermediate confirmation step for high risk
  if (user.pendingSend.isHighRisk && !user.pendingSend.highRiskConfirmed) {
    if (lowered === 'yes') {
      const updatedPending = {
        ...user.pendingSend,
        highRiskConfirmed: true,
        requestedAt: new Date(), // reset timestamp for PIN entry TTL
      };
      await prisma.user.update({
        where: { id: user.id },
        data: { pendingSend: updatedPending },
      });

      let confirmMsg = `Recipient confirmed.\nPlease confirm this payment:\nAmount: ${updatedPending.amount} ${updatedPending.asset}\nTo: [Recipient ${updatedPending.fingerprint}]\n`;
      if (updatedPending.memo) {
        confirmMsg += `Memo (${updatedPending.memoType || 'text'}): ${updatedPending.memo}\n`;
      }
      confirmMsg += `Reply with your PIN to send, or "no" to cancel.`;
      await notify(phoneNumber, confirmMsg);
      return true;
    } else {
      await notify(phoneNumber, 'Invalid reply. Please reply "YES" to confirm the high-risk recipient, or "NO" to cancel.');
      return true;
    }
  }

  const userWithPin = await prisma.user.findUnique({ where: { id: user.id } });
  if (!verifyPin(text, userWithPin.pinHash)) {
    await notify(phoneNumber, 'PIN verification failed. Please try again or reply "no" to cancel.');
    return true;
  }

  // Atomically claim (clear) the pending send BEFORE executing. Two
  // concurrent messages with a valid PIN both reach this point — the claim
  // guarantees exactly one of them executes the payment; the loser gets a
  // clear reply instead of a double spend. A payment that fails after the
  // claim requires the user to start the send again — the safe direction.
  const pending = user.pendingSend;
  if (!(await claimPendingSend({ prisma, Prisma, userId: user.id }))) {
    await notify(phoneNumber, 'That payment was already processed or cancelled.');
    return true;
  }

  // executePayment is the authoritative compliance boundary. Keeping policy
  // enforcement there ensures every payment channel applies it exactly once
  // and keeps compliance evaluation inside the transaction creation boundary.
  const result = await executePayment({
    sender: user,
    destination: pending.destination,
    amount: pending.amount,
    asset: pending.asset,
    memo: pending.memo,
    memoType: pending.memoType,
    routeType: pending.routeType,
  });

  await notify(phoneNumber, `Payment ${result.transaction.status}. Receipt: ${result.receipt.transactionId}`, {
    notification: {
      userId: user.id,
      type: 'transaction_receipt',
      referenceType: 'transaction',
      referenceId: result.transaction.id,
    },
  });
  return true;
};

// `notify` defaults to the real WhatsApp send so the webhook path (the only
// caller before the sim endpoints existed) is unaffected. The sim controller
// passes its own `notify` to capture replies inline instead of calling Meta —
// see apps/api/src/controllers/sim.controller.js.
const processMessage = async (phoneNumber, whatsappName, text, { notify = sendTextMessage } = {}) => {
  const user = await resolveUser(phoneNumber, whatsappName);
  if (await handlePendingPin({ phoneNumber, user, text, notify })) return;

  const normalized = String(text || '').trim().toLowerCase();

  if (['hi', 'hello', 'help', 'menu'].includes(normalized)) {
    await notify(phoneNumber, 'SendAm can help with send money, receive money, balance, contacts, transaction history, and receipts.');
    return;
  }

  if (normalized.includes('balance')) {
    await walletService.ensureWalletsForUser({ user });
    const balances = await walletService.balancesForUser({ userId: user.id });
    const lines = balances.flatMap((b) => {
      if (b.error) return [`${b.chain}: unavailable (${b.error})`];
      return (b.assets || []).map((a) => `${a.asset}: ${a.value}`);
    });
    await notify(phoneNumber, `Your SendAm balances:\n${lines.join('\n')}`);
    return;
  }

  if (normalized.includes('receive')) {
    const wallets = await walletService.ensureWalletsForUser({ user });
    const lines = wallets.map((w) => `${w.chain}: ${w.publicKey}`);
    await notify(phoneNumber, `Share one of these to receive money on SendAm:\n${lines.join('\n')}`);
    return;
  }

  if (normalized.includes('history') || normalized.includes('transactions')) {
    const transactions = await prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const lines = transactions.map((tx) => `${tx.type}: ${tx.amount} ${tx.asset} - ${tx.status}`);
    await notify(phoneNumber, lines.length ? lines.join('\n') : 'No transactions yet.');
    return;
  }

  const paymentIntent = parsePaymentIntent(text);
  if (paymentIntent) {
    await requestConfirmation({ phoneNumber, user, intent: paymentIntent, notify });
    return;
  }

  await notify(phoneNumber, 'I can help you send money, check balance, receive money, or show receipts.');
};

module.exports = {
  processMessage,
  parsePaymentIntent,
};
