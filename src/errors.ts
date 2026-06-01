/**
 * Exit code taxonomy.
 * 0 = success
 * 1 = user error (bad flags, unknown object, invalid input)
 * 2 = auth error (no alias, expired token, missing SF CLI files)
 * 3 = API error (Salesforce unreachable, rate-limited, 5xx)
 * 4 = internal bug (unexpected state, impossible code path)
 */
export const ExitCode = {
  OK: 0,
  USER: 1,
  AUTH: 2,
  API: 3,
  INTERNAL: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class SeedError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly hint?: string;

  constructor(message: string, exitCode: ExitCodeValue, hint?: string) {
    super(message);
    this.name = "SeedError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class UserError extends SeedError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.USER, hint);
    this.name = "UserError";
  }
}

export class AuthError extends SeedError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.AUTH, hint);
    this.name = "AuthError";
  }
}

export class ApiError extends SeedError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.API, hint);
    this.name = "ApiError";
  }
}

export class InternalError extends SeedError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.INTERNAL, hint);
    this.name = "InternalError";
  }
}

/**
 * Extract ONLY the fixed `errorCode` (REST) / `error` (OAuth) enum tokens
 * from a raw Salesforce error body.
 *
 * Salesforce puts record FIELD VALUES in the human-readable `message` /
 * `error_description` fields ("duplicate value found: Email__c duplicates
 * record 003... with value alice@acme.com", custom validation-rule text,
 * etc.). Those must never reach an LLM. The `errorCode` is a stable enum
 * (`MALFORMED_QUERY`, `DUPLICATE_VALUE`, `FIELD_CUSTOM_VALIDATION_EXCEPTION`,
 * …) and is safe to surface.
 *
 * The capture group is a STRICT identifier (`[A-Za-z][A-Za-z0-9_]*`): it
 * cannot match a string containing spaces, `@`, digits-with-punctuation, or
 * any other value shape — so even a malformed/adversarial body cannot smuggle
 * data out through this function. Regex-based (not JSON.parse) so it still
 * works on a body truncated mid-payload.
 */
export function extractSalesforceErrorCodes(bodyText: string): string[] {
  const codes = new Set<string>();
  const re = /"(?:errorCode|error)"\s*:\s*"([A-Za-z][A-Za-z0-9_]*)"/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(bodyText)) !== null) {
    codes.add(m[1]);
  }
  return [...codes];
}

/**
 * Build a model-safe one-line summary of a Salesforce HTTP error: status
 * plus the safe `errorCode` enum(s), and NOTHING from the response body
 * itself. This is the only shape of a Salesforce failure that may be put
 * into an Error message that can propagate to the LLM. Persist the raw body
 * to a session log on disk if you need the detail for debugging.
 *
 * e.g. `HTTP 400 Bad Request (MALFORMED_QUERY)`.
 */
export function salesforceErrorSummary(
  status: number,
  statusText: string,
  bodyText: string,
): string {
  const codes = extractSalesforceErrorCodes(bodyText);
  const st = (statusText ?? "").trim();
  const codePart = codes.length > 0 ? ` (${codes.join(", ")})` : "";
  return `HTTP ${status}${st ? ` ${st}` : ""}${codePart}`;
}
