import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type SfRunResult,
  type SfRunner,
  looksPlaintext,
  resolveAuth,
  tokenRejectedHint,
} from "../../src/auth/sf-auth.ts";
import { DescribeCache } from "../../src/describe/cache.ts";
import { DescribeClient } from "../../src/describe/client.ts";
import { ApiError, AuthError, ExitCode } from "../../src/errors.ts";

/**
 * Salesforce CLI ≥ 2.149 (plugin-org ≥ 6) redacts secrets from
 * `sf org display --json`. The `accessToken` field becomes the literal
 * placeholder below — 54 characters, no `00D` prefix, no `!` — and any tool
 * that forwards it as a Bearer token gets an opaque HTTP 401 from every org,
 * even ones logged into moments earlier. `sf` itself keeps working because
 * it decrypts and refreshes in-process.
 *
 * These tests pin the recovery: the resolver must never hand a placeholder
 * (or anything else that fails `looksPlaintext`) to an HTTP client. It either
 * obtains the real token another way or fails at resolve time with a message
 * that names the actual cause — and never echoes sf's free text, which can be
 * anything from an OAuth error description to a proxy's HTML error page.
 */

// Verbatim strings from plugin-org's `messages/secrets-redacted.md`.
const REDACTED_TOKEN = "[REDACTED] Use 'sf org auth show-access-token' to view";
const REDACTED_AUTH_URL = "[REDACTED] Use 'sf org auth show-sfdx-auth-url' to view";

const REAL_TOKEN = "00DcW0000012345!AR4AQMwxG.fake.token.body.for.tests.only.0123456789abcdef";
const INSTANCE_URL = "https://acme--dev.sandbox.my.salesforce.com";
const USERNAME = "user@acme.example.dev";
const ORG_ID = "00DcW0000012345EAA";
const ALIAS = "dev";

type Call = { args: string[]; env: Record<string, string> | undefined };

function ok(result: unknown, warnings: unknown[] = []): SfRunResult {
  return { code: 0, stdout: JSON.stringify({ status: 0, result, warnings }), stderr: "" };
}

function sfError(name: string, message: string, status = 1): SfRunResult {
  return {
    code: status,
    stdout: JSON.stringify({ status, name, message, exitCode: status, warnings: [] }),
    stderr: "",
  };
}

function displayPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORG_ID,
    apiVersion: "67.0",
    accessToken: REDACTED_TOKEN,
    instanceUrl: INSTANCE_URL,
    username: USERNAME,
    clientId: "PlatformCLI",
    connectedStatus: "Connected",
    sfdxAuthUrl: REDACTED_AUTH_URL,
    alias: ALIAS,
    ...overrides,
  };
}

/**
 * Builds a fake `sf` whose behaviour per subcommand is table-driven, and
 * records every invocation so tests can assert on flags and env.
 */
function fakeSf(handlers: {
  display?: (env: Record<string, string> | undefined) => SfRunResult | null;
  showAccessToken?: () => SfRunResult | null;
}): { runSf: SfRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runSf: SfRunner = async (args, env) => {
    calls.push({ args, env });
    const cmd = args.slice(0, 3).join(" ");
    if (cmd.startsWith("org display")) return handlers.display?.(env) ?? null;
    if (cmd === "org auth show-access-token") return handlers.showAccessToken?.() ?? null;
    return null;
  };
  return { runSf, calls };
}

/** An empty HOME so the `~/.sfdx` fallback never finds anything real. */
function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), "sf-auth-home-"));
}

/** A HOME whose `.sfdx` knows `alias` and holds an auth file with `token`. */
function homeWithAuthFile(alias: string, token: string): string {
  const home = emptyHome();
  const sfdx = join(home, ".sfdx");
  mkdirSync(sfdx);
  writeFileSync(join(sfdx, "alias.json"), JSON.stringify({ orgs: { [alias]: USERNAME } }));
  writeFileSync(
    join(sfdx, `${USERNAME}.json`),
    JSON.stringify({
      accessToken: token,
      instanceUrl: INSTANCE_URL,
      orgId: ORG_ID,
      username: USERNAME,
    }),
  );
  return home;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
}

describe("looksPlaintext", () => {
  it("accepts a real session-id-shaped token", () => {
    expect(looksPlaintext(REAL_TOKEN)).toBe(true);
    expect(looksPlaintext("00D5g000004Wcz2!AR4AQ")).toBe(true);
  });

  it("rejects the sf CLI redaction placeholder", () => {
    expect(REDACTED_TOKEN).toHaveLength(54);
    expect(looksPlaintext(REDACTED_TOKEN)).toBe(false);
  });

  it("rejects encrypted blobs and other prose", () => {
    expect(looksPlaintext("a0a1b2c3d4e5f60718293a4b5c6d7e8f:9a8b7c6d5e4f3a2b1c0d")).toBe(false);
    expect(looksPlaintext("")).toBe(false);
    expect(looksPlaintext("token")).toBe(false);
    // A `!` alone is no longer enough — placeholders can contain punctuation.
    expect(looksPlaintext("[REDACTED] Don't share this!")).toBe(false);
    // Org-id prefix alone is no longer enough either.
    expect(looksPlaintext("00DcW0000012345EAA")).toBe(false);
  });
});

describe("resolveAuth via sf CLI — redacted `org display` output", () => {
  it("asks SF_TEMP_SHOW_SECRETS of `org display` and uses the token when it comes back", async () => {
    const sf = fakeSf({
      display: (env) =>
        ok(
          displayPayload({
            accessToken: env?.SF_TEMP_SHOW_SECRETS === "true" ? REAL_TOKEN : REDACTED_TOKEN,
          }),
        ),
    });

    const auth = await resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() });

    expect(auth.accessToken).toBe(REAL_TOKEN);
    expect(auth).toMatchObject({
      username: USERNAME,
      orgId: ORG_ID,
      instanceUrl: INSTANCE_URL,
      apiVersion: "60.0",
      alias: ALIAS,
    });
    // One spawn is enough on CLIs that still honour the env var.
    expect(sf.calls).toHaveLength(1);
    expect(sf.calls[0].args).toEqual(["org", "display", "--target-org", ALIAS, "--json"]);
    expect(sf.calls[0].env).toEqual({ SF_TEMP_SHOW_SECRETS: "true" });
  });

  it("falls back to `sf org auth show-access-token --json` when the token is still redacted", async () => {
    const sf = fakeSf({
      display: () => ok(displayPayload()), // ignores the env var, as future CLIs will
      showAccessToken: () => ok({ accessToken: REAL_TOKEN }),
    });

    const auth = await resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() });

    expect(auth.accessToken).toBe(REAL_TOKEN);
    expect(auth.orgId).toBe(ORG_ID);
    expect(sf.calls.map((c) => c.args)).toEqual([
      ["org", "display", "--target-org", ALIAS, "--json"],
      ["org", "auth", "show-access-token", "--target-org", ALIAS, "--json"],
    ]);
  });

  it("never returns the placeholder: fails at resolve time when show-access-token prints nothing", async () => {
    const sf = fakeSf({
      display: () => ok(displayPayload()),
      showAccessToken: () => null, // crashed, or command missing
    });

    const err = await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    );

    expect(err).toBeInstanceOf(AuthError);
    const e = err as AuthError;
    expect(e.exitCode).toBe(ExitCode.AUTH);
    expect(e.message).toContain(`"${ALIAS}"`);
    expect(e.message).toMatch(/redacted/i);
    expect(e.message).toContain("`sf org auth show-access-token` printed no JSON");
    // Distinguishes this from an expired token: re-logging in is explicitly NOT the fix.
    expect(e.hint).toMatch(/not a login problem/i);
    expect(e.hint).toContain(`sf org auth show-access-token --target-org ${ALIAS} --json`);
    expect(e.hint).toContain("sf update");
    // The resolver already sets SF_TEMP_SHOW_SECRETS on its own spawn, so
    // telling the user to set it would be dead advice.
    expect(e.message + e.hint).not.toContain("SF_TEMP_SHOW_SECRETS");
    expect(e.message + e.hint).not.toMatch(/expired/i);
    // The placeholder text itself must not be echoed back either.
    expect(e.message + e.hint).not.toContain(REDACTED_TOKEN);
  });

  it("names show-access-token's error, and only its name", async () => {
    const sf = fakeSf({
      display: () => ok(displayPayload()),
      showAccessToken: () => sfError("NoAccessTokenError", `No access token found for ${USERNAME}`),
    });

    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;

    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("`sf org auth show-access-token` failed (NoAccessTokenError)");
    expect(err.message).not.toContain("No access token found");
  });

  it("also fails cleanly when show-access-token returns something unusable", async () => {
    const sf = fakeSf({
      display: () => ok(displayPayload()),
      showAccessToken: () => ok({ accessToken: REDACTED_TOKEN }),
    });

    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;

    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("did not return a token in the expected format");
    expect(err.message).not.toContain(REDACTED_TOKEN);
  });
});

describe("resolveAuth via sf CLI — session refresh failed before the token was printed", () => {
  function withStatus(status: unknown, warnings: unknown[] = []) {
    return fakeSf({
      display: () =>
        ok(displayPayload({ accessToken: REAL_TOKEN, connectedStatus: status }), warnings),
    });
  }

  it("dead refresh token → AuthError with the one phrase that matters, not sf's full sentence", async () => {
    const status = `Unable to refresh session due to: Error authenticating with the refresh token due to: expired access/refresh token (${USERNAME} at ${INSTANCE_URL})`;
    const sf = withStatus(status);

    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;

    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toBe(
      `The sf CLI could not refresh the session for org "${ALIAS}": expired access/refresh token.`,
    );
    expect(err.message).not.toContain(INSTANCE_URL);
    expect(err.hint).toContain(`sf org login web --alias ${ALIAS}`);
    // Did not bother calling show-access-token for an org it can't reach.
    expect(sf.calls).toHaveLength(1);
  });

  it("identifier-shaped SfError codes pass through as-is", async () => {
    const sf = withStatus("DomainNotFoundError");
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain(": DomainNotFoundError.");
  });

  it("free text (e.g. a proxy's HTML error page) is collapsed, never echoed", async () => {
    const body =
      '<!doctype html><html lang="en"><body>Blocked by corp-proxy-07.internal.example (10.1.2.3)</body></html>';
    const sf = withStatus(body);
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toBe(
      `The sf CLI could not refresh the session for org "${ALIAS}": session refresh failed.`,
    );
    expect(err.message + err.hint).not.toContain("corp-proxy");
    expect(err.message + err.hint).not.toContain("10.1.2.3");
    expect(err.message + err.hint).not.toContain("<html");
  });

  it.each([
    "Down (Maintenance)",
    "Bad Response",
    "fetch failed",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ERROR_HTTP_503",
  ])("transport failure %s → ApiError with a retry hint, no re-login advice", async (status) => {
    const sf = withStatus(status);
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.exitCode).toBe(ExitCode.API);
    expect(err.message).toBe(`The sf CLI could not reach org "${ALIAS}": ${status}.`);
    expect(err.hint).toMatch(/retry later/i);
    expect(err.hint).not.toContain("sf org login");
  });

  it("treats a missing connectedStatus (scratch orgs) as fine when nothing else is wrong", async () => {
    const sf = withStatus(undefined);
    const auth = await resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() });
    expect(auth.accessToken).toBe(REAL_TOKEN);
  });

  it("treats an empty-string connectedStatus like a missing one", async () => {
    const sf = withStatus("");
    const auth = await resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() });
    expect(auth.accessToken).toBe(REAL_TOKEN);
  });

  it("scratch org whose refresh failed: caught via the `warnings` array, not a downstream 401", async () => {
    // plugin-org omits connectedStatus for scratch orgs and only warns.
    const sf = withStatus(undefined, ["unable to refresh auth for org"]);
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("session refresh failed");
    expect(err.hint).toContain(`sf org login web --alias ${ALIAS}`);
  });

  it("the SF_TEMP_SHOW_SECRETS security warnings do not trip the refresh check", async () => {
    const sf = withStatus("Connected", [
      "The SF_TEMP_SHOW_SECRETS env var is set. This is a temporary env var …",
      "This command will expose sensitive information …",
    ]);
    const auth = await resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() });
    expect(auth.accessToken).toBe(REAL_TOKEN);
  });
});

describe("resolveAuth via sf CLI — the command itself failed", () => {
  it("unknown alias: named from the sf error envelope, free text withheld", async () => {
    const sf = fakeSf({
      display: () =>
        sfError("NamedOrgNotFoundError", "No authorization information found for nope.", 2),
    });

    const err = (await rejection(
      resolveAuth("nope", "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;

    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain('Unknown org "nope"');
    expect(err.message).toContain("NamedOrgNotFoundError");
    expect(err.message).not.toContain("No authorization information");
    expect(err.hint).toContain("sf org list --all");
  });

  it("NamedOrgNotFoundError for an alias the local store DOES know (scratch org, Dev Hub auth gone) is not called 'unknown'", async () => {
    const home = homeWithAuthFile(ALIAS, "a0a1b2c3d4e5f60718293a4b5c6d7e8f:9a8b7c6d5e4f3a2b1c0d");
    const sf = fakeSf({
      display: () =>
        sfError(
          "NamedOrgNotFoundError",
          "No authorization information found for hub@acme.example.",
          2,
        ),
    });

    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: home }),
    )) as AuthError;

    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).not.toContain("Unknown org");
    expect(err.message).toContain(`could not display org "${ALIAS}" (NamedOrgNotFoundError)`);
    expect(err.hint).toContain(`sf org display --target-org ${ALIAS}`);
  });

  it("any other sf error: surfaces the name only", async () => {
    const sf = fakeSf({
      display: () =>
        sfError("NoScratchInfo", "Could not find scratch org info for hub user hub@acme.example"),
    });
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toBe(`The sf CLI could not display org "${ALIAS}" (NoScratchInfo).`);
    expect(err.message).not.toContain("hub@acme.example");
  });

  it("an envelope with a name but no status is still an error", async () => {
    const sf = fakeSf({
      display: () => ({
        code: 1,
        stdout: JSON.stringify({ name: "SomethingError", message: "x" }),
        stderr: "",
      }),
    });
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("(SomethingError)");
  });

  it("a non-identifier error name is not interpolated", async () => {
    const sf = fakeSf({
      display: () => sfError("Bad thing at https://acme.example/x", "x"),
    });
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err.message).toContain("(unknown error)");
    expect(err.message).not.toContain("acme.example");
  });

  it("sf installed but crashing (non-zero exit, no JSON) is reported as such, stderr withheld", async () => {
    const sf = fakeSf({
      display: () => ({
        code: 127,
        stdout: "",
        stderr: "Error: Cannot find module '/opt/sf/lib/run.js'\n    at …",
      }),
    });
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("exited with status 127");
    expect(err.message).toContain(`sf org display --target-org ${ALIAS} --json`);
    expect(err.message + err.hint).not.toContain("Cannot find module");
    expect(err.hint).not.toContain("Install");
  });

  it("sf exiting clean with non-JSON output falls through to the auth-file path", async () => {
    const sf = fakeSf({
      display: () => ({ code: 0, stdout: "Org Description\n===\n", stderr: "" }),
    });
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain(`Could not resolve auth for target-org "${ALIAS}"`);
  });
});

describe("resolveAuth without a usable sf — the ~/.sfdx auth-file path", () => {
  const noSf = fakeSf({}); // every command → null, i.e. spawn failed

  it("reports clearly when nothing is there", async () => {
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: noSf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain(`Could not resolve auth for target-org "${ALIAS}"`);
  });

  it("uses a plaintext auth file", async () => {
    const home = homeWithAuthFile(ALIAS, REAL_TOKEN);
    const auth = await resolveAuth(ALIAS, "60.0", { runSf: noSf.runSf, homeDir: home });
    expect(auth).toMatchObject({
      accessToken: REAL_TOKEN,
      username: USERNAME,
      orgId: ORG_ID,
      instanceUrl: INSTANCE_URL,
      alias: ALIAS,
    });
  });

  it("refuses an encrypted auth file instead of sending the blob as a Bearer token", async () => {
    const blob = "a0a1b2c3d4e5f60718293a4b5c6d7e8f:9a8b7c6d5e4f3a2b1c0d";
    const home = homeWithAuthFile(ALIAS, blob);
    const err = (await rejection(
      resolveAuth(ALIAS, "60.0", { runSf: noSf.runSf, homeDir: home }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("appears encrypted");
    expect(err.message).not.toContain(blob);
  });
});

describe("resolveAuth — default target org", () => {
  it("uses the sf config's target-org when no alias is given", async () => {
    const home = emptyHome();
    mkdirSync(join(home, ".sf"));
    writeFileSync(join(home, ".sf", "config.json"), JSON.stringify({ "target-org": ALIAS }));
    const sf = fakeSf({ display: () => ok(displayPayload({ accessToken: REAL_TOKEN })) });

    const auth = await resolveAuth(undefined, "60.0", { runSf: sf.runSf, homeDir: home });

    expect(auth.alias).toBe(ALIAS);
    expect(sf.calls[0].args).toContain(ALIAS);
  });

  it("fails clearly when there is no default either", async () => {
    const sf = fakeSf({});
    const err = (await rejection(
      resolveAuth("", "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
    )) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("No --target-org provided");
    expect(sf.calls).toHaveLength(0);
  });
});

describe("acceptance: a redacted `sf org display` never turns into a bare HTTP 401", () => {
  /**
   * End-to-end through a real HTTP consumer. The fake Salesforce accepts
   * exactly one token; anything else — including the placeholder — is a 401.
   * The resolver's job is to make sure the placeholder never gets that far.
   */
  function fakeSalesforce(): { fetchFn: typeof fetch; bearers: string[] } {
    const bearers: string[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const bearer = (headers.Authorization ?? "").replace(/^Bearer /, "");
      bearers.push(bearer);
      if (bearer !== REAL_TOKEN) {
        return new Response(
          JSON.stringify([
            { message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" },
          ]),
          { status: 401, statusText: "Unauthorized" },
        );
      }
      return new Response(JSON.stringify({ encoding: "UTF-8", maxBatchSize: 200, sobjects: [] }), {
        status: 200,
      });
    };
    return { fetchFn, bearers };
  }

  it("describeGlobal succeeds with the token recovered via show-access-token", async () => {
    const sf = fakeSf({
      display: () => ok(displayPayload()), // 54-char placeholder, env var ignored
      showAccessToken: () => ok({ accessToken: REAL_TOKEN }),
    });
    const auth = await resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() });

    const salesforce = fakeSalesforce();
    const client = new DescribeClient({
      auth,
      cache: new DescribeCache({
        orgId: auth.orgId,
        ttlSeconds: 60,
        cacheRoot: mkdtempSync(join(tmpdir(), "sf-auth-describe-")),
      }),
      fetchFn: salesforce.fetchFn,
    });

    await expect(client.describeGlobal()).resolves.toMatchObject({ sobjects: [] });
    expect(salesforce.bearers).toEqual([REAL_TOKEN]);
    expect(salesforce.bearers).not.toContain(REDACTED_TOKEN);
  });

  it("with no recovery path, fails at resolve time without touching the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const sf = fakeSf({ display: () => ok(displayPayload()), showAccessToken: () => null });
      await expect(
        resolveAuth(ALIAS, "60.0", { runSf: sf.runSf, homeDir: emptyHome() }),
      ).rejects.toBeInstanceOf(AuthError);
      // No probe with the placeholder, no probe at all: the resolver never speaks HTTP.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("resolveAuth through the real `sf` spawn path", () => {
  /**
   * Everything above injects `runSf`. This exercises `defaultRunSf` itself —
   * the env merge that is the one-spawn fast path on Salesforce CLI 2.149.x,
   * and the not-on-PATH → null path — with a fake `sf` script on PATH. No
   * credentials involved; the script only echoes canned JSON.
   */
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function installFakeSf(): { log: string } {
    const bin = mkdtempSync(join(tmpdir(), "fake-sf-bin-"));
    const log = join(bin, "calls.log");
    const display = JSON.stringify({
      status: 0,
      result: displayPayload({ accessToken: "__TOKEN__" }),
      warnings: [],
    });
    const script = `#!/bin/sh
echo "$1 $2 $3|SF_TEMP_SHOW_SECRETS=\${SF_TEMP_SHOW_SECRETS-unset}" >> "${log}"
case "$1 $2" in
  "org display")
    if [ "\${SF_TEMP_SHOW_SECRETS}" = "true" ]; then TOKEN='${REAL_TOKEN}'; else TOKEN="${REDACTED_TOKEN}"; fi
    printf '%s' '${display}' | sed "s|__TOKEN__|\${TOKEN}|"
    exit 0 ;;
  *)
    echo "Error: command $1 $2 $3 not found" >&2
    exit 2 ;;
esac
`;
    writeFileSync(join(bin, "sf"), script);
    chmodSync(join(bin, "sf"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    return { log };
  }

  it.skipIf(process.platform === "win32")(
    "spawns `sf org display` with SF_TEMP_SHOW_SECRETS=true and gets the token in one call",
    async () => {
      const { log } = installFakeSf();

      const auth = await resolveAuth(ALIAS, "60.0", { homeDir: emptyHome() });

      expect(auth.accessToken).toBe(REAL_TOKEN);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "org display --target-org|SF_TEMP_SHOW_SECRETS=true",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "with no `sf` on PATH, falls through to the auth-file path",
    async () => {
      process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
      const home = homeWithAuthFile(ALIAS, REAL_TOKEN);

      const auth = await resolveAuth(ALIAS, "60.0", { homeDir: home });

      expect(auth.accessToken).toBe(REAL_TOKEN);
    },
  );
});

describe("tokenRejectedHint", () => {
  it("attributes a post-resolve 401 to expiry/revocation and names the alias", () => {
    const hint = tokenRejectedHint({
      username: USERNAME,
      orgId: ORG_ID,
      accessToken: REAL_TOKEN,
      instanceUrl: INSTANCE_URL,
      apiVersion: "60.0",
      alias: ALIAS,
    });
    expect(hint).toContain(`"${ALIAS}"`);
    expect(hint).toMatch(/expired or been revoked/);
    expect(hint).toContain(`sf org login web --alias ${ALIAS}`);
    expect(hint).not.toContain(REAL_TOKEN);
  });

  it("falls back to the username when there is no alias", () => {
    const hint = tokenRejectedHint({
      username: USERNAME,
      orgId: ORG_ID,
      accessToken: REAL_TOKEN,
      instanceUrl: INSTANCE_URL,
      apiVersion: "60.0",
    });
    expect(hint).toContain(`"${USERNAME}"`);
  });
});
