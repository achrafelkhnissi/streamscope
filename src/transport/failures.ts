import type { Failure, FailureKind } from './model';

interface ErrorDetails {
  code?: unknown;
  message?: unknown;
  reason?: unknown;
  hostname?: unknown;
  address?: unknown;
  port?: unknown;
}

const invalidRequestCodes: ReadonlySet<string> = new Set([
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_INVALID_CHAR',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_UNESCAPED_CHARACTERS',
  'ERR_INVALID_URL',
]);
const unreachableCodes: ReadonlySet<string> = new Set([
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);
const certificatePattern = /CERT|SELF_SIGNED|UNABLE_TO_|LEAF_SIGNATURE/;

function sentence(text: string): string {
  return text.trim().replace(/\.+$/, '');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function failure(kind: FailureKind, message: string, code: string | undefined): Failure {
  return { kind, message, code };
}

export function classifyError(error: unknown, phase: 'connect' | 'headers' | 'body'): Failure {
  const details: ErrorDetails = typeof error === 'object' && error !== null ? error : {};
  const code = text(details.code);
  const message = sentence(text(details.message) ?? String(error));
  const endpoint = `${text(details.address) ?? 'the server'}${details.port === undefined ? '' : `:${String(text(details.port))}`}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return failure('dns', `Could not resolve ${text(details.hostname) ?? 'the host'}.`, code);
  }
  if (code === 'ECONNREFUSED') {
    return failure('refused', `Connection refused: nothing is listening at ${endpoint}.`, code);
  }
  if (code !== undefined && unreachableCodes.has(code)) {
    return failure('refused', `Cannot reach ${endpoint} (${code}).`, code);
  }
  if (code === 'ETIMEDOUT') {
    return failure('connect-timeout', `The connection to ${endpoint} timed out.`, code);
  }
  if (code !== undefined && invalidRequestCodes.has(code)) {
    return failure('invalid-request', `The request is invalid: ${message}.`, code);
  }
  if (code?.startsWith('HPE_')) {
    const reason = sentence(text(details.reason) ?? message);
    return failure('protocol', `The server sent an invalid HTTP response: ${reason}.`, code);
  }
  if (code !== undefined && certificatePattern.test(code)) {
    return failure(
      'tls',
      `The server's TLS certificate was rejected: ${message}. Trust it with streamscope.request.caFile, or add # @insecure to this request.`,
      code,
    );
  }
  if (code === 'EPROTO' || code?.startsWith('ERR_SSL_') || code?.startsWith('ERR_TLS_')) {
    return failure('tls', `The TLS handshake failed: ${message}.`, code);
  }
  if (phase === 'body') {
    return failure(
      'premature-close',
      `The connection closed before the response was complete (${message}).`,
      code,
    );
  }
  return failure('reset', `The connection failed before a response arrived (${message}).`, code);
}
