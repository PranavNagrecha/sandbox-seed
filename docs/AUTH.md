# Authentication

`sandbox-seed` does not implement its own login flow. It reads from the Salesforce CLI's auth store (`~/.sf/` and `~/.sfdx/`).

This means:
- Zero config if you already use `sf`.
- One-time login if you don't.
- No tokens are stored by `sandbox-seed` itself.

---

## The standard flow

### 1. Install the Salesforce CLI

```bash
npm install -g @salesforce/cli
```

Or via the official installer: https://developer.salesforce.com/tools/salesforcecli

### 2. Log into your orgs

```bash
# Source org (production, or wherever your real data lives)
sf org login web --alias prod

# Target org (the sandbox you're seeding into)
sf org login web --alias dev-full
```

Use the same aliases consistently — they're what you'll pass to the `seed` tool's `sourceOrg` and `targetOrg` parameters.

### 3. Verify

```bash
sf org list --all
```

You should see both aliases. That's it — `sandbox-seed` will pick them up automatically.

---

## How auth resolution works

For each org alias, `sandbox-seed`:

1. **Shells out to `sf`** (`sf org display --target-org <alias> --json`) if `sf` is on your `PATH`. This is the most reliable path — `sf` refreshes the session, decrypts the stored token, and reports `connectedStatus`.
2. **Recovers the token if `sf` redacted it.** Salesforce CLI ≥ 2.149 (`@salesforce/plugin-org` ≥ 6) hides `accessToken` from `org display` output by default, replacing it with a `[REDACTED] Use 'sf org auth show-access-token' to view` placeholder. `sandbox-seed` sets `SF_TEMP_SHOW_SECRETS=true` on that call (the CLI's documented, temporary opt-out) and, if the token still comes back redacted, runs `sf org auth show-access-token --target-org <alias> --json` — the command the placeholder points at. `--json` skips its interactive confirmation.
3. **Falls back to reading `~/.sfdx/<username>.json` directly** if `sf` isn't installed. This only works for plaintext (older) auth files. Encrypted tokens require `sf`.

Whatever the path, the token is shape-checked (`00D…!…`) before it is used. A placeholder or an encrypted blob is never sent as a `Bearer` token — that would only surface later as an opaque `HTTP 401` — so auth problems fail at resolve time with a message that names the actual cause. Messages carry only fixed error names and classifications; `sf`'s own free-text output (which can be anything from an OAuth error description to a proxy's HTML page) is never echoed.

Source: [src/auth/sf-auth.ts](https://github.com/PranavNagrecha/sandbox-seed/blob/main/src/auth/sf-auth.ts).

---

## Default org

If you don't pass `--target-org` to the CLI, `sandbox-seed inspect` uses your `sf` default (set with `sf config set target-org <alias>`).

The MCP `seed` tool always requires explicit `sourceOrg` and `targetOrg` — there is no implicit default for seeding, on purpose.

---

## Permissions

The Salesforce user you authenticate with needs:

| Action | Permission |
|---|---|
| `inspect` (read-only describe) | `View Setup and Configuration` |
| `inspect --include-counts` | `Read` on the queried objects |
| `seed` source org | `Read` + `View All` (if querying records you don't own) on the seeded objects |
| `seed` target org | `Create` / `Edit` on the seeded objects + their parents/children that you opt in to |
| `disableValidationRulesOnRun` | `Customize Application` (to toggle ValidationRule.Active) |

Use a scoped integration user, not your main admin account. The boundary contract limits what the *AI* sees; it does not limit what your *Salesforce user* can do.

---

## Common errors

### `Unknown org "prod" — the sf CLI has no authorization for it (NamedOrgNotFoundError)`

You haven't run `sf org login` for that alias, or the alias lives in a different `HOME`. Run `sf org list --all` to confirm.

### `The sf CLI could not display org "prod" (<ErrorName>)`

`sf org display` failed for a reason other than an unknown alias — for example a scratch org whose Dev Hub authorization has since been removed (`NamedOrgNotFoundError` naming the hub) or expired (`NoScratchInfo`). Only the error's name is shown; run `sf org display --target-org prod` to see the full text.

### `The sf CLI exited with status <n> running sf org display … and printed no JSON`

`sf` is on `PATH` but crashed (missing Node runtime, broken plugin install, …). Run the quoted command yourself to see why. This is distinct from `sf` not being installed at all, which falls through to the auth-file path below.

### `The sf CLI did not expose a usable access token for "prod"`

`sf org display` returned the `[REDACTED]` placeholder, and `sf org auth show-access-token --target-org prod --json` — the command the placeholder points at — did not yield a token either (the message says what it did instead: printed no JSON, failed with a named error, or returned something that isn't token-shaped). This is **not** a login problem; re-running `sf org login` changes nothing, and `sandbox-seed` already sets `SF_TEMP_SHOW_SECRETS=true` on its own `org display` call, so setting it yourself will not help. Run the `show-access-token` command yourself to see what the CLI reports, and make sure `@salesforce/plugin-org` is current (`sf update`).

### `The sf CLI could not refresh the session for org "prod": …`

`sf` tried to refresh the session before handing over the token and failed. The stored token is stale, so the tool stops here instead of sending it. After the colon you get a classification — `expired access/refresh token`, an error name such as `DomainNotFoundError`, or `session refresh failed` for anything else — never `sf`'s raw text. Run `sf org login web --alias prod` and retry; `sf org display --target-org prod` shows the full error. For scratch orgs, which `sf` reports differently, the same message appears when `sf` warned that it was unable to refresh auth.

### `The sf CLI could not reach org "prod": …`

Same pre-flight refresh, but the failure is transport-level (`Down (Maintenance)`, `Bad Response`, `fetch failed`, `ENOTFOUND`, `ETIMEDOUT`, `ERROR_HTTP_5xx`). Re-authenticating cannot fix this; it is an `ApiError` (exit code 3) with a retry-later hint.

### `Access token for "prod" appears encrypted`

You're falling through the `sf`-not-installed path with an encrypted auth file. Install `sf` (`npm i -g @salesforce/cli`) and retry.

### `ProductionTargetRefused`

The tool checked `Organization.IsSandbox` on your target and got `false`. This is the safety gate. There is no override.

### `Authentication rejected by Salesforce (HTTP 401)` mid-run

The token passed the resolve-time checks and came from `sf`, and Salesforce has since rejected it — it expired or was revoked. The tool does not refresh mid-run. Re-authenticate (`sf org login web --alias <name>`) and resume; the session is recoverable from the last completed action.

---

## What `sandbox-seed` doesn't do

- Doesn't implement OAuth itself. We delegate to `sf`.
- Doesn't store credentials. Tokens stay in `~/.sf/` and `~/.sfdx/`, owned by the Salesforce CLI.
- Doesn't refresh tokens. `sf` does that for us when we shell out.
- Doesn't support JWT bearer flow directly. Use `sf org login jwt` to set it up in `sf`, and we'll consume it.
