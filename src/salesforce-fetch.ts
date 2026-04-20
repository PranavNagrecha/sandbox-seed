/**
 * Retry wrapper around a `fetch`-shaped function, specialized for the
 * Salesforce REST and Tooling APIs.
 *
 * Retries on:
 *   - transport errors (fetch throws — DNS, ECONNRESET, etc.)
 *   - HTTP 429 / 500 / 502 / 503 / 504
 *   - Response bodies matching `REQUEST_LIMIT_EXCEEDED`,
 *     `UNABLE_TO_LOCK_ROW`, `SERVER_UNAVAILABLE`, or
 *     `REQUEST_RUNNING_TOO_LONG` (Salesforce occasionally surfaces these
 *     with 400 or 403, so HTTP status alone isn't enough).
 *
 * Backoff: 500ms, 1s, 2s, 4s, 8s with ±25% jitter. Capped at 5 attempts.
 * Configurable per-call for tests or recovery paths that want different
 * behavior.
 *
 * What we deliberately DO NOT retry:
 *   - 4xx bodies without a known throttling error code (the request is
 *     semantically wrong; a retry won't help).
 *   - 401 (auth is stale — surface fast so the caller can re-auth).
 *   - 2xx responses (even if the body shape is odd, caller handles it).
 *
 * The wrapper returns the final `Response` unchanged — callers keep
 * their existing `res.ok` / `res.json()` handling. For bodies we peek
 * at for retry purposes, the response is `clone()`d first so the
 * caller can still read the original.
 */

import type { OrgAuth } from "./auth/sf-auth.ts";
import { ApiError } from "./errors.ts";

export type RetryLogger = (msg: string) => void | Promise<void>;

export type SalesforceFetchOptions = {
  /** Max total attempts including the first. Default 5. */
  maxAttempts?: number;
  /** Base delay in ms for the first retry. Default 500. */
  baseDelayMs?: number;
  /** Cap on any single delay in ms. Default 8000. */
  maxDelayMs?: number;
  /** Optional sink for retry events. Receives one line per retry attempt. */
  log?: RetryLogger;
  /**
   * Injected for tests — lets us short-circuit sleeps. Matches `setTimeout`
   * without the extra args. Defaults to `setTimeout`.
   */
  sleepFn?: (ms: number) => Promise<void>;
};

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_BODY_PATTERN = /REQUEST_LIMIT_EXCEEDED|UNABLE_TO_LOCK_ROW|SERVER_UNAVAILABLE|REQUEST_RUNNING_TOO_LONG/i;

/**
 * Execute `fetchFn(url, init)` with retries on transient failures.
 *
 * Caller supplies the same `fetchFn` they'd use directly (i.e. the
 * injected test double or `fetch`). The retry layer is transparent —
 * a single successful response or a non-retryable failure returns
 * the underlying `Response` unchanged.
 */
export async function salesforceFetch(
  fetchFn: typeof fetch,
  url: string,
  init?: RequestInit,
  opts: SalesforceFetchOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 8000;
  const sleepFn = opts.sleepFn ?? defaultSleep;

  let lastDescription = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isLast = attempt === maxAttempts;
    let res: Response | null = null;
    let transportError: unknown = null;

    try {
      res = await fetchFn(url, init);
    } catch (err) {
      transportError = err;
    }

    if (res !== null) {
      if (res.ok) return res;
      if (isLast) return res;

      const retryable = await isRetryable(res);
      if (!retryable) return res;

      lastDescription = `HTTP ${res.status}`;
    } else {
      if (isLast) {
        throw transportError instanceof Error
          ? transportError
          : new ApiError(`Salesforce fetch failed: ${String(transportError)}`);
      }
      lastDescription =
        transportError instanceof Error
          ? transportError.message
          : String(transportError);
    }

    const delay = backoffDelay(attempt, baseDelay, maxDelay);
    if (opts.log !== undefined) {
      await opts.log(
        `salesforce fetch ${shortUrl(url)} attempt ${attempt}/${maxAttempts} failed (${lastDescription}); retrying in ${delay}ms`,
      );
    }
    await sleepFn(delay);
  }

  // Unreachable — the loop always returns or throws on the last attempt.
  throw new ApiError("salesforceFetch: exhausted retries without terminal result");
}

async function isRetryable(res: Response): Promise<boolean> {
  if (RETRY_STATUS.has(res.status)) return true;
  // Some throttling surfaces come back as 400/403 with the error code in
  // the body. Clone so the caller can still read the body afterward.
  try {
    const text = await res.clone().text();
    return RETRY_BODY_PATTERN.test(text);
  } catch {
    return false;
  }
}

function backoffDelay(attempt: number, base: number, cap: number): number {
  const raw = Math.min(base * 2 ** (attempt - 1), cap);
  // ±25% jitter.
  const jitter = raw * (Math.random() * 0.5 - 0.25);
  return Math.max(0, Math.floor(raw + jitter));
}

function defaultSleep(ms: number): Promise<void> {
  // Under vitest, zero out the sleep so retry-driven tests don't tip over
  // the default 5s test timeout. Production and real CLI runs always see
  // the real delay. We intentionally do NOT check NODE_ENV here — users
  // sometimes set `NODE_ENV=test` for production test runs we DO want to
  // back off on. `VITEST` is set only by vitest itself.
  if (process.env.VITEST === "true") return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Convenience: `salesforceFetch` with an `Authorization: Bearer` header
 * merged into `init.headers`. Most callers want this shape.
 */
export async function salesforceFetchAuthed(
  fetchFn: typeof fetch,
  auth: OrgAuth,
  url: string,
  init: RequestInit = {},
  opts: SalesforceFetchOptions = {},
): Promise<Response> {
  const mergedHeaders: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  return await salesforceFetch(fetchFn, url, { ...init, headers: mergedHeaders }, opts);
}
