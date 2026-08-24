const { verifyToken, hasPermission } = require('../services/adminAuth.service');
const { writeAuditLog } = require('../common/audit.service');
const { sendError } = require('../utils/response');
const authenticateAdmin = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const admin = await verifyToken(header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!admin) return sendError(res, 'Unauthorized', 401);
    req.admin = admin; return next();
  } catch (error) { return next(error); }
};
const requirePermission = (permission) => async (req, res, next) => {
  if (hasPermission(req.admin, permission)) {
    await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.route.accessed', metadata: { permission, method: req.method, path: req.originalUrl }, req });
    return next();
  }
  await writeAuditLog({ actorType: 'administrator', actorId: req.admin.id, action: 'admin.authorization.denied', metadata: { permission, method: req.method, path: req.originalUrl }, req });
  return sendError(res, 'Forbidden', 403);
};
const requireAdmin = (permission = 'admin.read') => [authenticateAdmin, requirePermission(permission)];
requireAdmin.authenticate = authenticateAdmin; requireAdmin.permission = requirePermission;
module.exports = requireAdmin;
