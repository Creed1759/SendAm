# Security Policy

SendAm handles wallet keys and money movement, so we take security seriously even while the project is a Testnet MVP. This document explains how to report a vulnerability and summarizes the current security posture.

## Supported Status

SendAm is currently a **Stellar Testnet MVP**. It is not configured for real-money production use. Testnet XLM has no monetary value, but real user data (e.g. phone numbers) may be present, so please treat security issues with appropriate care.

## Reporting a Vulnerability

**Do not open a public issue for serious vulnerabilities**, including:

- Stellar secret key exposure or weaknesses in key encryption/handling.
- Authentication bypass (admin auth, webhook signature verification).
- Admin API route exposure.
- Transaction-signing or transfer-authorization vulnerabilities.
- Production credential or secret leaks.

Instead, report privately through **GitHub private vulnerability reporting**:

1. Go to <https://github.com/EF-CHAIN/SendAm/security/advisories/new> and fill
   in the advisory form. This keeps the details private to the maintainers
   until a fix is ready.

Please include when you can: affected component, reproduction steps, impact, and
any suggested fix. We aim to **acknowledge reports within 48 hours** and will
coordinate disclosure once a fix is available.

## Safe Harbor

We consider security research conducted in accordance with this policy to be:

- **Authorized** under applicable anti-hacking laws, and we will not initiate
  legal action against you for your research.
- **Exempt** from the DMCA, and you are not liable for circumvention of
  technology controls to the extent your activity is covered by this policy.
- **Helpful and conducted in good faith**, so we will work with you to resolve
  any issues before public disclosure.

We ask that you make a good-faith effort to avoid privacy violations,
destruction of data, and disruption of production services. Do not access or
modify data that does not belong to you, and stop testing and report immediately
once you have confirmed a vulnerability.

## Current Security Posture

Already in place:

- **Authenticated encryption & key versioning** of wallet secrets with AES-256-GCM (`v1:` version header format with support for key rotation and backward compatibility). No fallback key — a missing/invalid `ENCRYPTION_KEY` fails loudly at startup.
- **Admin authentication** via HMAC-signed, expiring session tokens. The API refuses to start without `ADMIN_PASSWORD` and `JWT_SECRET`; the login endpoint is rate-limited and all admin data routes require a valid Bearer token.
- **WhatsApp webhook signature verification** against the `X-Hub-Signature-256` header, fail-closed in production.
- **Idempotency** on inbound WhatsApp messages to prevent duplicate transfers from webhook retries.
- **Input validation** of Stellar public keys, amounts, and phone numbers on every surface.
- **Transfer guardrails**: per-transaction cap plus rolling 24h amount and count limits, with an upfront balance check.
- **Compliance review workflow**: KYC approval, sanctions screening, and custody review gates are now represented in the backend policy and persisted in `KycProfile`.
- **Audit logging** for wallet creation and payment execution is already present; the compliance workflow records review decisions and can be extended to log any manual approvals or denials.
- **CORS allowlist** enforced in production and **PostgreSQL-backed rate limiting** shared across instances (per-IP REST, per-sender WhatsApp). Rate limit counters live in the `RateLimitHit` table via Prisma — see [`apps/api/src/middlewares/postgresRateStore.js`](apps/api/src/middlewares/postgresRateStore.js) and [`apps/api/src/services/rateLimit.service.js`](apps/api/src/services/rateLimit.service.js).
- The **unauthenticated REST wallet API** is disabled in production by default (`ENABLE_WALLET_REST_API`); WhatsApp is the signature-verified product surface.
- **SEP-10 REST authentication** is built: REST clients prove wallet ownership via a Stellar key challenge before accessing wallet, PIN, and KYC routes. See [`docs/STELLAR.md`](docs/STELLAR.md#sep-10-rest-authentication).

## Compliance Assumptions and Threat Boundaries

- The repo is built for a **direct custody** model: user wallet secret keys are encrypted at rest, and all settlement happens through the server-side Stellar wallet adapter.
- The compliance workflow assumes an AML program with manual review gates for:
  - KYC status and tier-based transaction limits.
  - sanctions screening by destination country and cross-border transfers.
  - custody review statuses for accounts that require additional operational approval.
- The current implementation includes a **local sanctions screening baseline** for high-risk and blocked countries, but any production deployment must use a licensed sanctions screening provider and confirm the list with legal counsel.
- Operational ownership is split as follows:
  - **Compliance team**: KYC approvals, sanctions clearance, custody review decisions, and maintaining approved jurisdictions.
  - **Security team**: encryption key management, admin auth, audit logging, and endpoint hardening.
  - **Operations team**: production monitoring, database backups, and alerts for review queue growth or failed transfers.

## Known Limitations / Hardening Still Required

Before any real-money launch:

- Migrate from Stellar Testnet to mainnet with a vetted deployment.
- Replace the single static `ENCRYPTION_KEY` with managed key management (KMS/HSM) and key rotation.
- Add per-user authentication to the REST wallet API (or keep it disabled). The SEP-10 auth service is built; it needs deployment configuration (`ENABLE_WALLET_REST_API=true`, `STELLAR_AUTH_SIGNING_KEY`, domain variables).
- Build real per-user authentication for `POST /api/compliance/pin` and `POST /api/compliance/kyc/start` — right now they rely on the same phone-number identity model and share the `ENABLE_WALLET_REST_API` flag.
- Replace the single shared admin password with real admin accounts and roles.
- Add audit logging for sensitive actions, plus monitoring and alerting.
- Complete legal, compliance, KYC, AML, and custody review where required.

## Responsible Use During Development

- Use Stellar **Testnet** for development; never use real funds.
- Never commit secrets, private keys, access tokens, or `.env` files.
- Do not expose encrypted secret keys in API responses or logs.

## Customer Privacy Lifecycle (NDPA / NDPR)

SendAm implements a customer privacy lifecycle covering access/export, deletion
requests, legal holds, financial-record retention, media/transcript handling, and
irreversible identity anonymization. The source of truth for what we store and
how long is [`apps/api/src/compliance/retention.js`](apps/api/src/compliance/retention.js);
the workflow logic is in [`apps/api/src/compliance/privacy.service.js`](apps/api/src/compliance/privacy.service.js).

### Data inventory (personal data we hold)

| Model | Field(s) | Classification |
| --- | --- | --- |
| User | `phoneNumber`, `whatsappName` | pii |
| User | `pinHash` | secret (never exported/audited) |
| Wallet | `phoneNumber` | pii |
| Wallet | `encryptedSecretKey` | secret (custody; nulled on erasure, public key kept) |
| Transaction | `amount`, `asset`, `txHash` | financial / identifier (retained for AML) |
| Transaction | `destination`, `recipientPhoneNumber` | pii (redacted on erasure) |
| KycProfile | `providerReference` | identifier (AML proof; retained) |
| KycProfile | `metadata` (applicant PII) | pii (redacted on erasure) |
| VoiceCommand | `transcript`, `phoneNumber` | communications / pii |
| Contact | `phoneNumber`, `displayName` | pii |
| Alias | `alias`, `target` | pii (rows deleted on erasure) |
| Notification | `recipient`, `body` | communications |
| AuditLog | `action`, `entityId`, `metadata` | audit (redacted on write) |

### Retention matrix

| Model | Erasure policy | Notes |
| --- | --- | --- |
| User | **erased** | Anonymized in place; id/derived scores (AML) kept. |
| Wallet | **redacted** | Secret key nulled; public key + balances (custody) kept. |
| Transaction | **retained** | Full ledger kept; counterparty PII redacted. |
| KycProfile | **redacted** | Applicant PII redacted; verification proof + `providerReference` kept. |
| VoiceCommand | **erased** | Transcript + phone redacted. |
| Contact / Alias | **erased** | Rows anonymized / deleted. |
| Notification | **redacted** | Recipient + body redacted. |
| Quote / RestSession | **redacted** | Counterparty PII / token redacted. |
| AuditLog / KycWebhookEvent / WhatsappStatusEvent | **retained** | Integrity/audit trail; no raw PII. |

### Legal holds

A legal hold (`LegalHold`) suspends erasure for a user and is indefinite unless an
explicit `expiresAt` is set. While active, an erasure request is **denied** and no
provider propagation runs. Holds are set/released only by `compliance.write`
admins and are themselves audited.

### Provider propagation

An approved erasure creates one `PrivacyProviderTask` per configured provider
(`smileid`, `whatsapp`, `voice`, `monitoring`). Each adapter is best-effort and
gated behind an operator-configured deletion URL
(`SMILE_ID_DATA_DELETION_URL`, `WHATSAPP_DATA_DELETION_URL`,
`DEEPGRAM_DATA_DELETION_URL`, `MONITORING_DATA_DELETION_URL`). When unconfigured
the task is recorded as **skipped** (visible, not failed); on a real failure the
task is **failed** and can be retried via `POST /api/admin/privacy-requests/:id/retry`.

### Authorization, auditability, and redaction

- Export is self-service for the authenticated customer (`POST /api/compliance/privacy/export`).
- Erasure is self-service to *request*; fulfillment requires `compliance.write` approval.
- Every request, approval, denial, completion, failure, legal-hold change, and
  provider retry writes an `AuditLog` entry whose `metadata` contains **only**
  status/type/counts — never phone numbers, document numbers, transcripts, or secrets.
- Exports exclude `SECRET_FIELDS` (`pinHash`, `encryptedSecretKey`, `passwordHash`, `tokenHash`).

### NDPA / NDPR assumptions (for legal review)

- NDPA 2023 recognises a right to erasure except where retention is required by law
  (tax, AML/CFT, accounting). CBN/AML rules require keeping transaction and KYC
  verification records for **at least 5 years** after the relationship ends.
- Erasure is therefore implemented as **anonymization**: identity PII is removed
  while ledger, settlement, and verification-proof records are retained.
- Cross-border corridors (e.g. NG ↔ GH/KE) may impose longer local retention; use
  legal holds to extend retention per corridor rather than blocking erasure broadly.
- These are product/engineering assumptions, **not legal advice**; confirm with
  qualified Nigerian counsel before launch.

