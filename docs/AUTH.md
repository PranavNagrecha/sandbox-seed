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

1. **Shells out to `sf`** (`sf org display --target-org <alias> --json`) if `sf` is on your `PATH`. This is the most reliable path — `sf` handles token refresh, encryption, OAuth nuances.
2. **Falls back to reading `~/.sfdx/<username>.json` directly** if `sf` isn't installed. This only works for plaintext (older) auth files. Encrypted tokens require `sf`.

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

### `Unknown org "prod"`

You haven't run `sf org login` for that alias. Or the alias is set in a different shell env. Run `sf org list --all` to confirm.

### `Access token for "prod" appears encrypted`

You're falling through the `sf`-not-installed path with an encrypted auth file. Install `sf` (`npm i -g @salesforce/cli`) and retry.

### `ProductionTargetRefused`

The tool checked `Organization.IsSandbox` on your target and got `false`. This is the safety gate. There is no override.

### Token expired mid-run

If you started a long seed and your access token expired, the tool surfaces a clear `AuthError` and the session is recoverable — re-authenticate with `sf` and resume from the last action.

---

## What `sandbox-seed` doesn't do

- Doesn't implement OAuth itself. We delegate to `sf`.
- Doesn't store credentials. Tokens stay in `~/.sf/` and `~/.sfdx/`, owned by the Salesforce CLI.
- Doesn't refresh tokens. `sf` does that for us when we shell out.
- Doesn't support JWT bearer flow directly. Use `sf org login jwt` to set it up in `sf`, and we'll consume it.
