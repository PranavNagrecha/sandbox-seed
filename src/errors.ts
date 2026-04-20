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
