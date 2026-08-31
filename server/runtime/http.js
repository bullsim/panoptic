/**
 * Minimal HTTP helpers shared by PANOPTIC collectors.
 *
 * Deliberately small: this module holds only what the migrated CelesTrak
 * collector actually uses today. Helpers are added here when a collector
 * genuinely needs them, not in anticipation of one.
 *
 * @module server/runtime/http
 */

/**
 * Route-relative path for a request mounted under a connect prefix.
 *
 * Connect strips the mount path before invoking the handler, so `req.url` is
 * already relative to the collector's route; this drops the leading slash and
 * any query string.
 *
 * @param {import('node:http').IncomingMessage} req - Incoming request.
 * @returns {string} Path segment with no leading slash and no query string.
 */
export function routePath(req) {
  return String(req?.url || '').replace(/^\//, '').split('?')[0];
}

/**
 * Write a `text/plain` response, guarding against a double send.
 *
 * A throw AFTER a response has already gone out would otherwise route into a
 * catch that calls `writeHead` again, which throws "Cannot set headers after
 * they are sent" and masks the original error.
 *
 * @param {import('node:http').ServerResponse} res - Response to write.
 * @param {number} status - HTTP status code.
 * @param {string} body - Response body.
 * @param {Record<string,string>} [headers] - Extra headers merged over the content type.
 * @returns {void}
 */
export function sendText(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
  res.end(body);
}
