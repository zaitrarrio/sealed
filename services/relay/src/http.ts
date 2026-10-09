/** Error model shared by the Worker and the Durable Objects (which return `Result`s across RPC). */
import { ErrorCode, type ErrorBody } from "@sealed/core";

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface Failure {
  ok: false;
  status: number;
  code: ErrorCodeValue;
  message?: string;
}

export type Result<T> = { ok: true; value: T } | Failure;

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(status: number, code: ErrorCodeValue, message?: string): Failure {
  return message === undefined ? { ok: false, status, code } : { ok: false, status, code, message };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCodeValue,
    message?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }

  body(): ErrorBody {
    return this.message && this.message !== this.code ? { error: this.code, message: this.message } : { error: this.code };
  }
}

/** Unwraps a DO `Result`, throwing its failure as an HttpError. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new HttpError(r.status, r.code, r.message);
}

export const Errors = {
  badRequest: (m?: string) => new HttpError(400, ErrorCode.BadRequest, m),
  unauthorized: (m?: string) => new HttpError(401, ErrorCode.Unauthorized, m),
  forbidden: (m?: string) => new HttpError(403, ErrorCode.Forbidden, m),
  notFound: (m?: string) => new HttpError(404, ErrorCode.NotFound, m),
  tooLarge: (m?: string) => new HttpError(413, ErrorCode.TooLarge, m),
  rateLimited: (retryAfter = 60) => new HttpError(429, ErrorCode.RateLimited, "slow down", { "retry-after": String(retryAfter) }),
  conflict: (m?: string) => new HttpError(409, ErrorCode.Conflict, m),
};

export function errorResponse(e: HttpError): Response {
  return new Response(JSON.stringify(e.body()), { status: e.status, headers: { "content-type": "application/json; charset=utf-8", ...e.headers } });
}
