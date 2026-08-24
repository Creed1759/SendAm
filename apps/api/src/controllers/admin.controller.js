const { sendSuccess, sendError, sendPaginated } = require('../utils/response');
const { authenticate, createInvitation, acceptInvitation, revokeSessions, hashPassword } = require('../services/adminAuth.service');
const { writeAuditLog } = require('../common/audit.service');
const prisma = require('../common/prisma');
const { withIdAliases } = require('../common/records');

// Parse ?page and ?limit into safe bounds so list endpoints can never be asked
// to load the entire collection at once. Defaults to 50/page, capped at 100.
const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const result = await authenticate(email, password);
    if (!result) {
      await writeAuditLog({ actorType: 'anonymous', action: 'admin.login.denied', metadata: { email: String(email || '').toLowerCase() }, req });
      return sendError(res, 'Invalid credentials', 401);
    }
    await writeAuditLog({ actorType: 'administrator', actorId: result.admin.id, action: 'admin.login.succeeded', entityType: 'AdminSession', entityId: result.session.id, req });
    return sendSuccess(res, { token: result.token, administrator: { id: result.admin.id, email: result.admin.email, name: result.admin.name, role: result.admin.role.name } }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

const acceptInvite = async (req, res, next) => {
  try {
    const admin = await acceptInvitation(req.body?.token, req.body?.password);
    await writeAuditLog({ actorType: 'administrator', actorId: admin.id, action: 'admin.invitation.accepted', entityType: 'AdminUser', entityId: admin.id, req });
    return sendSuccess(res, null, 'Account created', 201);
  } catch (error) { if (error.statusCode) return sendError(res, error.message, error.statusCode); return next(error); }
};

const listAdministrators = async (_req, res, next) => {
  try {
    const admins = await prisma.adminUser.findMany({ select: { id: true, email: true, name: true, disabledAt: true, lastLoginAt: true, createdAt: true, role: { select: { name: true, permissions: true } } }, orderBy: { createdAt: 'asc' } });
    return sendSuccess(res, admins);
  } catch (error) { return next(error); }
};

const inviteAdministrator = async (req, res, next) => {
  try {
    const { invitation, token } = await createInvitation({ email: req.body?.email, name: req.body?.name, roleName: req.body?.role, createdById: req.admin.id });
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.invitation.created', entityType: 'AdminInvitation', entityId: invitation.id, metadata: { email: invitation.email }, req });
    return sendSuccess(res, { invitationId: invitation.id, token, expiresAt: invitation.expiresAt }, 'Invitation created', 201);
  } catch (error) { if (error.statusCode) return sendError(res, error.message, error.statusCode); return next(error); }
};

const enabledAdministratorCount = () => prisma.adminUser.count({ where: { disabledAt: null, role: { name: 'administrator' } } });
const updateAdministratorRole = async (req, res, next) => {
  try {
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id }, include: { role: true } });
    const role = await prisma.adminRole.findUnique({ where: { name: req.body?.role } });
    if (!target || !role) return sendError(res, 'Administrator or role not found', 404);
    if (target.role.name === 'administrator' && role.name !== 'administrator' && await enabledAdministratorCount() <= 1) return sendError(res, 'Cannot remove the last enabled administrator', 409);
    await prisma.adminUser.update({ where: { id: target.id }, data: { roleId: role.id } });
    await revokeSessions(target.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.role.changed', entityType: 'AdminUser', entityId: target.id, metadata: { from: target.role.name, to: role.name }, req });
    return sendSuccess(res, null, 'Role updated; active sessions revoked');
  } catch (error) { return next(error); }
};

const disableAdministrator = async (req, res, next) => {
  try {
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id }, include: { role: true } });
    if (!target) return sendError(res, 'Administrator not found', 404);
    if (target.role.name === 'administrator' && !target.disabledAt && await enabledAdministratorCount() <= 1) return sendError(res, 'Cannot disable the last enabled administrator', 409);
    await prisma.adminUser.update({ where: { id: target.id }, data: { disabledAt: new Date() } }); await revokeSessions(target.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.account.disabled', entityType: 'AdminUser', entityId: target.id, req });
    return sendSuccess(res, null, 'Administrator disabled');
  } catch (error) { return next(error); }
};

const resetCredential = async (req, res, next) => {
  try {
    const passwordHash = await hashPassword(req.body?.password);
    const target = await prisma.adminUser.update({ where: { id: req.params.id }, data: { passwordHash, passwordChangedAt: new Date() } }); await revokeSessions(target.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.credential.reset', entityType: 'AdminUser', entityId: target.id, req });
    return sendSuccess(res, null, 'Credential reset; active sessions revoked');
  } catch (error) { if (error.statusCode) return sendError(res, error.message, error.statusCode); return next(error); }
};

const revokeAdministratorSessions = async (req, res, next) => {
  try {
    await revokeSessions(req.params.id);
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.sessions.revoked', entityType: 'AdminUser', entityId: req.params.id, req });
    return sendSuccess(res, null, 'Sessions revoked');
  } catch (error) { return next(error); }
};

const logout = async (req, res, next) => {
  try {
    await prisma.adminSession.update({ where: { id: req.admin.sessionId }, data: { revokedAt: new Date() } });
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.session.revoked', entityType: 'AdminSession', entityId: req.admin.sessionId, req });
    return sendSuccess(res, null, 'Logged out');
  } catch (error) { return next(error); }
};

const getStats = async (req, res, next) => {
  try {
    const [
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      pendingKyc,
      voiceCommands,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.wallet.count(),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'success' } }),
      prisma.transaction.count({ where: { status: 'failed' } }),
      prisma.transaction.count({ where: { status: { in: ['pending', 'processing'] } } }),
      prisma.kycProfile.count({ where: { status: { in: ['pending', 'review'] } } }),
      prisma.voiceCommand.count(),
    ]);

    sendSuccess(res, {
      totalUsers,
      totalWallets,
      totalTransactions,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      pendingKyc,
      voiceCommands,
    });
  } catch (error) {
    next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        include: { wallets: { select: { chain: true, publicKey: true, network: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count(),
    ]);
    sendPaginated(res, withIdAliases(users.map((user) => ({
      ...user,
      pinHash: undefined,
    }))), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getWallets = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [wallets, total] = await Promise.all([
      prisma.wallet.findMany({
        include: { user: { select: { phoneNumber: true, whatsappName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.wallet.count(),
    ]);
    sendPaginated(res, withIdAliases(wallets.map((wallet) => ({
      ...wallet,
      encryptedSecretKey: undefined,
      userId: wallet.user,
    }))), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        include: { user: { select: { phoneNumber: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.transaction.count(),
    ]);
    sendPaginated(res, withIdAliases(transactions.map((transaction) => ({
      ...transaction,
      userId: transaction.user,
    }))), { page, limit, total });
  } catch (error) {
    next(error);
  }
};

const getKycProfiles = async (_req, res, next) => {
  try {
    const profiles = await prisma.kycProfile.findMany({
      include: { user: { select: { phoneNumber: true, whatsappName: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    sendSuccess(res, withIdAliases(profiles.map((profile) => ({
      ...profile,
      userId: profile.user,
    }))));
  } catch (error) {
    next(error);
  }
};

const getAuditLogs = async (_req, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    sendSuccess(res, withIdAliases(logs));
  } catch (error) {
    next(error);
  }
};

const getSystemHealth = async (_req, res, next) => {
  try {
    sendSuccess(res, {
      api: 'ok',
      database: 'ok',
      queues: process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL ? 'redis-configured' : 'unavailable',
      settlementRail: 'stellar',
      custodyModel: 'direct',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  acceptInvite,
  logout,
  listAdministrators,
  inviteAdministrator,
  updateAdministratorRole,
  disableAdministrator,
  resetCredential,
  revokeAdministratorSessions,
  getStats,
  getUsers,
  getWallets,
  getTransactions,
  getKycProfiles,
  getAuditLogs,
  getSystemHealth,
};
