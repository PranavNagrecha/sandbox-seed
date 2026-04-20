import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthError } from "../errors.ts";

export type OrgAuth = {
  username: string;
  orgId: string;
  accessToken: string;
  instanceUrl: string;
  apiVersion: string;
  alias?: string;
};

/**
 * Resolve authentication for a given org alias (or the default target org).
 *
 * Strategy (phase 1):
 *   1. If `sf` is on PATH, shell out to `sf org display --target-org <alias> --json`.
 *      This is the most reliable path: `sf` handles encrypted tokens, refresh, etc.
 *   2. Otherwise, fall back to reading `~/.sfdx/<username>.json` directly. This only
 *      works with plaintext tokens (older installs); encrypted tokens require `sf`.
 *
 * We deliberately do NOT depend on `@salesforce/core` — it's a heavy dependency and
 * shelling out gives us the same guarantees with no install-time cost.
 */
export async function resolveAuth(
  alias: string | undefined,
  apiVersion: string,
): Promise<OrgAuth> {
  if (alias === undefined || alias.length === 0) {
    const defaultAlias = await readDefaultTargetOrg();
    if (defaultAlias === undefined) {
      throw new AuthError(
        "No --target-org provided and no default target-org configured.",
        "Set one with `sf config set target-org <alias>` or pass --target-org <alias>.",
      );
    }
    alias = defaultAlias;
  }

  const viaCli = await tryResolveViaSfCli(alias, apiVersion);
  if (viaCli !== null) return viaCli;

  const viaFile = await tryResolveViaAuthFile(alias, apiVersion);
  if (viaFile !== null) return viaFile;

  throw new AuthError(
    `Could not resolve auth for target-org "${alias}".`,
    "Run `sf org login web --alias " +
      alias +
      "` to authenticate. Phase 1 requires either the `sf` CLI installed or an unencrypted `~/.sfdx/<username>.json`.",
  );
}

type SfOrgDisplayPayload = {
  accessToken?: unknown;
  instanceUrl?: unknown;
  username?: unknown;
  id?: unknown;
};

async function tryResolveViaSfCli(alias: string, apiVersion: string): Promise<OrgAuth | null> {
  const result = await runSfOrgDisplay(alias);
  if (result === null) return null;

  const r = (result.result ?? result) as SfOrgDisplayPayload;
  if (
    typeof r.accessToken !== "string" ||
    typeof r.instanceUrl !== "string" ||
    typeof r.username !== "string" ||
    typeof r.id !== "string"
  ) {
    return null;
  }

  return {
    username: r.username,
    orgId: r.id,
    accessToken: r.accessToken,
    instanceUrl: r.instanceUrl,
    apiVersion,
    alias,
  };
}

async function runSfOrgDisplay(
  alias: string,
): Promise<({ result?: SfOrgDisplayPayload } & SfOrgDisplayPayload) | null> {
  return new Promise((resolve) => {
    const proc = spawn("sf", ["org", "display", "--target-org", alias, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
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
      if (code !== 0 && stdout.length === 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch {
        resolve(null);
      }
      void stderr;
    });
  });
}

async function tryResolveViaAuthFile(alias: string, apiVersion: string): Promise<OrgAuth | null> {
  const sfdxDir = join(homedir(), ".sfdx");

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

  if (typeof accessToken !== "string" || typeof instanceUrl !== "string" || typeof orgId !== "string") {
    return null;
  }

  if (!looksPlaintext(accessToken)) {
    throw new AuthError(
      `Access token for "${alias}" appears encrypted. Phase 1 requires the \`sf\` CLI for encrypted auth files.`,
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

async function readDefaultTargetOrg(): Promise<string | undefined> {
  const paths = [
    join(homedir(), ".sf", "config.json"),
    join(homedir(), ".sfdx", "sfdx-config.json"),
  ];
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
 * token. Two positive signals (either is sufficient):
 *   - Starts with `00D` — the Org ID prefix carried at the head of the token.
 *   - Contains `!` — tokens are formatted as `<OrgId>!<rest>`.
 *
 * Encrypted tokens pulled from `~/.sf/` on systems where the OS keychain
 * holds the key look like opaque base64 — no `00D` prefix, no `!`. Returning
 * `false` here tells the caller "don't try to use this; shell out to `sf`."
 *
 * Naming: inverted semantics on purpose. The prior `looksEncrypted` forced
 * call sites to read a negative ("is NOT encrypted"), which made the
 * `!token.startsWith(...) && !token.includes(...)` body a double-negative to
 * reason about. `looksPlaintext` is a positive predicate: true means "use
 * this token directly."
 */
function looksPlaintext(token: string): boolean {
  return token.startsWith("00D") || token.includes("!");
}
