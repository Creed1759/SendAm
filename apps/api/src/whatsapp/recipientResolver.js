const { isValidPhoneNumber, canonicalizePhoneNumber } = require('../utils/validators');

const PHONE_SHAPE = /^\+?\d[\d\s-]{4,17}$/;
const looksLikePhoneNumber = (raw) => PHONE_SHAPE.test(raw) && isValidPhoneNumber(raw);

/**
 * Resolves recipient identifiers in the following precedence order:
 * 1. Saved contacts (name lookup)
 * 2. Phone numbers (creates or fetches user wallet)
 * 3. @names
 * 4. Raw G... Stellar addresses
 */
const createRecipientResolver = ({ prisma, walletService }) => {
  return async (user, recipient) => {
    const raw = String(recipient || '').trim();
    const normalized = raw.toLowerCase();

    // 1. Saved contacts — exact alias match.
    const savedAlias = await prisma.alias.findUnique({
      where: { userId_alias: { userId: user.id, alias: normalized } },
    });
    if (savedAlias) return { destination: savedAlias.target, label: normalized };

    // 2. Phone number — create or fetch wallet for that phone number.
    if (walletService && looksLikePhoneNumber(raw)) {
      const canonicalPhone = canonicalizePhoneNumber(raw);
      const wallet = await walletService.createOrGetWallet({ phoneNumber: canonicalPhone });
      return { destination: wallet.publicKey, label: canonicalPhone };
    }

    // 3. Raw address (or an unresolvable name — the confirmation flow's
    // address check will reject that with a clear message).
    return { destination: raw, label: raw };
  };
};

module.exports = { createRecipientResolver };
