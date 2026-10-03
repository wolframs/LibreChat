const cookie = require('cookie');
const { createBrowserSessionAuth, tenantContextMiddleware } = require('@librechat/api');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { getUserById, findSession } = require('~/models');

module.exports = createBrowserSessionAuth({
  findSession,
  getUserById,
  runAsSystem,
  establishTenantContext: tenantContextMiddleware,
  warn: logger.warn.bind(logger),
  parseCookies: cookie.parse,
});
