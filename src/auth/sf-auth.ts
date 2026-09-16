import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiError, AuthError } from "../errors.ts";

export type OrgAuth = {
  username: string;
  orgId: string;
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
  alias?: string;
};

/**
 * Outcome of one `sf` invocation. `null` means the binary could not be
 * spawned at all (not on PATH, EACCES, …) — distinct from `sf` running and
 * exiting non-zero, which still yields stdout/stderr.
 */
export type SfRunResult = { code: number | null; stdout: string; stderr: string };

/** Runs `sf <args>` with `extraEnv` layered over `process.env`. */
export type SfRunner = (
  args: string[],
  extraEnv?: Record<string, string>,
) => Promise<SfRunResult | null>;

export type ResolveAuthOptions = {
  /** Injected for tests — replaces spawning the real `sf` binary. */
  runSf?: SfRunner;
  /** Injected for tests — root that `~/.sf` and `~/.sfdx` are resolved under. */
  homeDir?: string;
};

/**
 * Resolve authentication for a given org alias (or the default target org).
 *
 * Strategy:
 *   1. If `sf` is on PATH, shell out to `sf org display --target-org <alias> --json`.
 *      This is the most reliable path: `sf` handles encrypted tokens, refresh, etc.
 *      Salesforce CLI ≥ 2.149 (plugin-org ≥ 6) redacts `accessToken` from that
 *      output by default, so we (a) set `SF_TEMP_SHOW_SECRETS=true` for the call,
 *      which restores the token on CLIs that still honour it, and (b) when the
 *      token still comes back redacted, ask the dedicated
 *      `sf org auth show-access-token --json` command instead.
 *   2. Otherwise, fall back to reading `~/.sfdx/<username>.json` directly. This only
 *      works with plaintext tokens (older installs); encrypted tokens require `sf`.
 *
 * Whatever the path, the token is shape-checked (`looksPlaintext`) before it is
 * returned: a redaction placeholder or an encrypted blob must never end up in an
 * `Authorization: Bearer` header, where it would surface as an opaque HTTP 401.
 *
 * We deliberately do NOT depend on `@salesforce/core` — it's a heavy dependency and
 * shelling out gives us the same guarantees with no install-time cost.
 */
export async function resolveAuth(
  alias: string | undefined,
  apiVersion: string,
  opts: ResolveAuthOptions = {},
): Promise<OrgAuth> {
  const runSf = opts.runSf ?? defaultRunSf;
  const homeDir = opts.homeDir ?? homedir();

  const target =
    alias === undefined || alias.length === 0 ? await readDefaultTargetOrg(homeDir) : alias;
  if (target === undefined) {
    throw new AuthError(
      "No --target-org provided and no default target-org configured.",
      "Set one with `sf config set target-org <alias>` or pass --target-org <alias>.",
    );
  }

  const viaCli = await tryResolveViaSfCli(target, apiVersion, runSf, homeDir);
  if (viaCli !== null) return viaCli;

  const viaFile = await tryResolveViaAuthFile(target, apiVersion, homeDir);
  if (viaFile !== null) return viaFile;

  throw new AuthError(
    `Could not resolve auth for target-org "${target}".`,
    `Run \`sf org login web --alias ${target}\` to authenticate. Requires either the \`sf\` CLI installed or an unencrypted \`~/.sfdx/<username>.json\`.`,
  );
}

/**
 * Hint attached to a Salesforce HTTP 401 raised *after* `resolveAuth` has
 * already vetted the token's shape. At that point the token was well-formed
 * and came from `sf`, so the honest explanation is expiry or revocation —
 * not a redaction or keychain problem.
 */
export function tokenRejectedHint(auth: OrgAuth): string {
  const who = auth.alias ?? auth.username;
  return (
    `Salesforce rejected the access token the sf CLI supplied for "${who}" — it has likely ` +
    `expired or been revoked. Run \`sf org login web --alias ${who}\` and retry.`
  );
}

/** Outer envelope every `sf … --json` command prints, success or failure. */
type SfJsonEnvelope = {
  status?: unknown;
  name?: unknown;
  result?: unknown;
  warnings?: unknown;
};

type SfOrgDisplayPayload = {
  accessToken?: unknown;
  instanceUrl?: unknown;
  username?: unknown;
  id?: unknown;
  connectedStatus?: unknown;
};

/**
 * Restores `accessToken` in `sf org display --json` on Salesforce CLI builds
 * that redact it by default. The CLI documents this env var as a temporary
 * workaround slated for removal; when it stops working we fall through to
 * `sf org auth show-access-token` below, so nothing here depends on it.
 */
const SHOW_SECRETS_ENV: Record<string, string> = { SF_TEMP_SHOW_SECRETS: "true" };

async function tryResolveViaSfCli(
  alias: string,
  apiVersion: string,
  runSf: SfRunner,
  homeDir: string,
): Promise<OrgAuth | null> {
  const displayArgs = ["org", "display", "--target-org", alias, "--json"];
  const run = await runSf(displayArgs, SHOW_SECRETS_ENV);
  // `sf` is not spawnable at all: let the auth-file path try.
  if (run === null) return null;

  const display = parseSfJson(run.stdout);
  if (display === null) {
    // Exited clean but printed no JSON — unknown shape, let the auth-file path try.
    if (run.code === 0) return null;
    // Installed but crashed (missing runtime, broken plugin, …). Say so rather
    // than falling through to an "install the sf CLI" message.
    throw new AuthError(
      `The sf CLI exited with status ${run.code ?? "unknown"} running \`sf ${displayArgs.join(" ")}\` and printed no JSON.`,
      "Run that command yourself to see the error. sandbox-seed needs a working `sf` to read this org's credentials.",
    );
  }

  if (isSfErrorEnvelope(display)) {
    await throwSfCommandError(alias, display, homeDir);
  }

  const r = payloadOf(display) as SfOrgDisplayPayload;
  if (
    typeof r.instanceUrl !== "string" ||
    typeof r.username !== "string" ||
    typeof r.id !== "string"
  ) {
    return null;
  }

  // `sf org display` refreshes the session before printing. When that refresh
  // fails it still prints the (now stale) stored token and reports why in
  // `connectedStatus` — for scratch orgs, which omit that field, only in a
  // "unable to refresh auth for org" warning. Surface either here rather than
  // as an opaque 401 on the first real request.
  const refreshWarned = warningsOf(display).some((w) => /unable to refresh auth/i.test(w));
  const rawStatus =
    typeof r.connectedStatus === "string" && r.connectedStatus.length > 0
      ? r.connectedStatus
      : refreshWarned
        ? "session refresh failed"
        : "Connected";
  if (rawStatus !== "Connected") {
    throwNotConnected(alias, rawStatus);
  }

  let accessToken = typeof r.accessToken === "string" ? r.accessToken : "";

  if (!looksPlaintext(accessToken)) {
    // plugin-org ≥ 6 replaces the token with a "[REDACTED] Use 'sf org auth
    // show-access-token' to view" placeholder. Sending that as a Bearer token
    // is exactly the HTTP 401 users saw; ask the command it points at instead.
    const showArgs = ["org", "auth", "show-access-token", "--target-org", alias, "--json"];
    const shown = await runSfJson(runSf, showArgs);
    const candidate =
      shown === null || isSfErrorEnvelope(shown)
        ? undefined
        : (payloadOf(shown) as { accessToken?: unknown }).accessToken;

    if (typeof candidate !== "string" || !looksPlaintext(candidate)) {
      // Reaching here means the CLI ignored SF_TEMP_SHOW_SECRETS (we already
      // set it on the display call — telling the user to set it would be dead
      // advice) AND the dedicated command failed. Name what it said.
      const why =
        shown === null
          ? "printed no JSON"
          : isSfErrorEnvelope(shown)
            ? `failed (${sfErrorName(shown)})`
            : "did not return a token in the expected format";
      throw new AuthError(
        `The sf CLI did not expose a usable access token for "${alias}": \`sf org display\` returned a redacted placeholder, and \`sf org auth show-access-token\` ${why}.`,
        `This is not a login problem — re-running \`sf org login\` will not change it. Run \`sf ${showArgs.join(" ")}\` yourself to see what the CLI reports, and make sure @salesforce/plugin-org is current (\`sf update\`).`,
      );
    }
    accessToken = candidate;
  }

  return {
    username: r.username,
    orgId: r.id,
    accessToken,
    instanceUrl: r.instanceUrl,
    apiVersion,
    alias,
  };
}

/**
 * Reduce what `sf org display` reports when its pre-flight session refresh
 * fails to something safe to print. plugin-org sets `connectedStatus` to
 * `error.code ?? error.message`, so it is an identifier for transport and
 * SfError failures but free text for refresh-token failures — up to and
 * including a proxy's whole HTML error page. Only identifier-shaped values
 * and two known constants pass through; prose is collapsed to a fixed
 * summary, with the one refresh-token phrase users actually need preserved.
 *
 * Transport failures get an `ApiError` with a retry hint: re-authenticating
 * cannot fix an org that is down or a DNS lookup that failed.
 */
function throwNotConnected(alias: string, status: string): never {
  const isTransport =
    status === "Down (Maintenance)" ||
    status === "Bad Response" ||
    status === "fetch failed" ||
    /^E[A-Z_]+$/.test(status) || // Node errno codes: ENOTFOUND, ECONNRESET, ETIMEDOUT, EAI_AGAIN
    /^ERROR_HTTP_\d{3}$/.test(status);
  const summary = isTransport
    ? status
    : /expired access\/refresh token/i.test(status)
      ? "expired access/refresh token"
      : /^[A-Za-z][A-Za-z0-9_]*$/.test(status)
        ? status // DomainNotFoundError, RefreshTokenAuthError, …
        : "session refresh failed";

  if (isTransport) {
    throw new ApiError(
      `The sf CLI could not reach org "${alias}": ${summary}.`,
      `The org or the network is unavailable right now; retry later. If it persists, run \`sf org display --target-org ${alias}\` for details.`,
    );
  }
  throw new AuthError(
    `The sf CLI could not refresh the session for org "${alias}": ${summary}.`,
    `Run \`sf org login web --alias ${alias}\` to re-authenticate, then retry. \`sf org display --target-org ${alias}\` shows the full error.`,
  );
}

async function runSfJson(runSf: SfRunner, args: string[]): Promise<SfJsonEnvelope | null> {
  const run = await runSf(args);
  return run === null ? null : parseSfJson(run.stdout);
}

function parseSfJson(stdout: string): SfJsonEnvelope | null {
  if (stdout.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed !== null && typeof parsed === "object" ? (parsed as SfJsonEnvelope) : null;
  } catch {
    return null;
  }
}

/** `sf … --json` failures carry `status !== 0` (and usually a `name`) with no `result`. */
function isSfErrorEnvelope(e: SfJsonEnvelope): boolean {
  if (typeof e.status === "number" && e.status !== 0) return true;
  return e.result === undefined && typeof e.name === "string";
}

/**
 * The fixed error *name* of an sf failure (`NamedOrgNotFoundError`, …) — and
 * only that. It is shape-checked like `extractSalesforceErrorCodes` does for
 * REST bodies; the free-text `message` stays out of anything that can reach
 * a log or an LLM, in keeping with the rest of the codebase's error handling.
 */
function sfErrorName(e: SfJsonEnvelope): string {
  return typeof e.name === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(e.name)
    ? e.name
    : "unknown error";
}

async function throwSfCommandError(
  alias: string,
  e: SfJsonEnvelope,
  homeDir: string,
): Promise<never> {
  const name = sfErrorName(e);
  // NamedOrgNotFoundError usually means the alias itself is unknown — but for
  // a scratch org it can also mean the org is known and its *Dev Hub* auth is
  // gone (`org display` looks the hub up before printing). Only call the alias
  // unknown when the local sf store agrees.
  const knownLocally = (await aliasToUsername(alias, join(homeDir, ".sfdx"))) !== null;
  if (name === "NamedOrgNotFoundError" && !knownLocally) {
    throw new AuthError(
      `Unknown org "${alias}" — the sf CLI has no authorization for it (${name}).`,
      `Run \`sf org list --all\` to see your aliases, or \`sf org login web --alias ${alias}\` to add this one.`,
    );
  }
  throw new AuthError(
    `The sf CLI could not display org "${alias}" (${name}).`,
    `Run \`sf org display --target-org ${alias}\` to see the full error, then \`sf org login web --alias ${alias}\` if it is an auth problem.`,
  );
}

/** Modern `sf` nests the command output under `result`; very old builds printed it bare. */
function payloadOf(e: SfJsonEnvelope): Record<string, unknown> {
  if (e.result !== null && typeof e.result === "object") return e.result as Record<string, unknown>;
  return e as Record<string, unknown>;
}

/** The `warnings` array of an `sf … --json` envelope, string entries only. */
function warningsOf(e: SfJsonEnvelope): string[] {
  return Array.isArray(e.warnings)
    ? e.warnings.filter((w): w is string => typeof w === "string")
    : [];
}

function defaultRunSf(
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<SfRunResult | null> {
  return new Promise((resolve) => {
    const proc = spawn("sf", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", () => {
      resolve(null);
    });
    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function tryResolveViaAuthFile(
  alias: string,
  apiVersion: string,
  homeDir: string,
): Promise<OrgAuth | null> {
  const sfdxDir = join(homeDir, ".sfdx");

  const username = await aliasToUsername(alias, sfdxDir);
  if (username === null) return null;

  const authFilePath = join(sfdxDir, `${username}.json`);
  let raw: string;
  try {
    raw = await readFile(authFilePath, "utf8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const accessToken = parsed.accessToken;
  const instanceUrl = parsed.instanceUrl;
  const orgId = parsed.orgId;

  if (
    typeof accessToken !== "string" ||
    typeof instanceUrl !== "string" ||
    typeof orgId !== "string"
  ) {
    return null;
  }

  if (!looksPlaintext(accessToken)) {
    throw new AuthError(
      `Access token for "${alias}" appears encrypted. Reading auth files directly requires a plaintext token; encrypted auth files require the \`sf\` CLI.`,
      "Install the `sf` CLI (https://developer.salesforce.com/tools/salesforcecli) and retry.",
    );
  }

  return {
    username,
    orgId,
    accessToken,
    instanceUrl,
    apiVersion,
    alias,
  };
}

async function aliasToUsername(alias: string, sfdxDir: string): Promise<string | null> {
  if (alias.includes("@")) return alias;

  const aliasPath = join(sfdxDir, "alias.json");
  try {
    const raw = await readFile(aliasPath, "utf8");
    const parsed = JSON.parse(raw) as { orgs?: Record<string, string> };
    const username = parsed.orgs?.[alias];
    return username ?? null;
  } catch {
    return null;
  }
}

async function readDefaultTargetOrg(homeDir: string): Promise<string | undefined> {
  const paths = [join(homeDir, ".sf", "config.json"), join(homeDir, ".sfdx", "sfdx-config.json")];
  for (const p of paths) {
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v = parsed["target-org"] ?? parsed.defaultusername;
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      // ignore, try next
    }
  }
  return undefined;
}

/**
 * Sanity-check that `token` looks like a Salesforce plaintext OAuth access
 * token: `<15-char OrgId starting 00D>!<rest>`. Both signals are required —
 * the `!` alone is too weak now that `sf` can hand back prose in this field.
 *
 * Returning `false` means "do not send this as a Bearer token". It catches:
 *   - the `[REDACTED] Use 'sf org auth show-access-token' to view` placeholder
 *     that Salesforce CLI ≥ 2.149 prints from `sf org display`;
 *   - encrypted blobs read straight from `~/.sf/` on systems where the OS
 *     keychain holds the key — opaque hex/base64, no `00D`, no `!`.
 *
 * Naming: a positive predicate on purpose. The prior `looksEncrypted` forced
 * call sites into a double-negative; `looksPlaintext === true` reads as "use
 * this token directly."
 */
export function looksPlaintext(token: string): boolean {
  return /^00D[A-Za-z0-9]{12}!/.test(token);
}
