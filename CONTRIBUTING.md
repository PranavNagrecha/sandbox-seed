# Contributing

Thanks for looking at `sandbox-seed`. This doc gets you from clone to running tests in about 2 minutes.

---

## Dev setup

```bash
git clone https://github.com/PranavNagrecha/sandbox-seed.git
cd sandbox-seed
npm install
```

Requires Node.js ≥ 20.

### Verify your setup

```bash
npm run typecheck      # TypeScript — must pass
npm test               # Vitest — must pass
npm run build          # Full build
```

If all three pass, you're ready.

### Optional but recommended

- A scratch Salesforce org or developer edition (`sf org create scratch`) for end-to-end testing against real describe calls.
- Authenticate: `sf org login web --alias scratch`.

---

## Running locally

### CLI (dev mode, no build)

```bash
npm run inspect:dev -- --object Case --target-org scratch
```

This runs `bin/dev.ts` with Node's experimental TS stripping — no build step.

### MCP server (dev mode)

```bash
npm run mcp:dev
```

Spawns the MCP server on stdio. You can drive it with `scripts/drive-mcp.mjs`:

```bash
node scripts/drive-mcp.mjs
```

Or point a real MCP host at it — in your `mcp.json`:

```json
{
  "mcpServers": {
    "sandbox-seed-dev": {
      "command": "npm",
      "args": ["run", "mcp:dev"],
      "cwd": "/absolute/path/to/your/clone"
    }
  }
}
```

---

## Project structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module-by-module breakdown.

Quick orientation:

```
src/
├── auth/       # Salesforce auth (delegates to sf CLI)
├── describe/   # Describe API + cache
├── graph/      # DAG + SCC + topological order
├── seed/       # Session state, extract, dry-run, execute, FK remap
├── mcp/        # MCP server + the single seed tool
└── commands/   # oclif CLI commands

tests/          # Mirrors src/ layout
```

---

## Tests

```bash
npm test                                  # all tests
npm run test:watch                        # watch mode
npx vitest run tests/graph/cycles.test.ts # single file
```

### Boundary tests are load-bearing

These encode the AI-boundary contract. **Do not weaken them to make a feature work:**

- `tests/mcp/ai-boundary.test.ts` — no record data escapes the tool response
- `tests/mcp/seed-boundary.test.ts` — sandbox-only, dry-run-before-run, confirm-on-run
- `tests/seed/dry-run-gate.test.ts` — the gate itself
- `tests/seed/validation-rule-toggle.test.ts` — recovery path

If you're changing the MCP tool surface, read these first.

---

## Code style

- TypeScript, strict mode.
- Biome for lint + format: `npm run lint`, `npm run lint:fix`.
- No comments that restate what the code does. Comments explain *why*, not *what*.
- Error paths use `SeedError` / `UserError` / `AuthError` from `src/errors.ts`. These serialize cleanly into MCP responses.

---

## Committing

- No required commit message format.
- Keep PRs focused. One behavior change per PR where practical.
- If you change a tool-surface shape, update [docs/MCP.md](docs/MCP.md) in the same PR.

---

## Release flow (maintainers)

Releases run via GitHub Actions + npm Trusted Publisher (OIDC). No tokens on anyone's laptop.

```bash
# 1. Bump version + tag
npm version patch     # or minor / major
git push --follow-tags

# 2. Create a GitHub Release
gh release create v0.2.6 --generate-notes

# 3. Watch the Actions tab; workflow publishes to npm automatically
```

The workflow is [.github/workflows/publish.yml](.github/workflows/publish.yml). It runs lint → typecheck → tests → build → publish. A failure at any step blocks the release.

### Setting up Trusted Publisher (one-time, done)

Already configured for `PranavNagrecha/sandbox-seed` + `publish.yml`. If you fork and want to publish your own version under a different name, see [npm's Trusted Publisher docs](https://docs.npmjs.com/generating-provenance-statements).

---

## Reporting security issues

Please do **not** file public issues for security problems.

Email: [pranav.nagrecha11@gmail.com](mailto:pranav.nagrecha11@gmail.com)

Specifically for AI-boundary issues (record data leaking into tool responses), include:
- Which tool action reproduces the leak
- Minimum repro input
- Observed output

The boundary is the product's entire security posture. Reports are taken seriously.

---

## What we won't accept

- PRs that weaken or route around the AI-boundary contract
- PRs that remove the sandbox-only target check
- PRs that allow `run` without a prior `dry_run` for the same session
- PRs that add network-dependent tests (use fixtures; see `tests/describe/cache.test.ts` for the pattern)

---

## Good first issues

- More render formats for `inspect` (PlantUML? GraphML?)
- Additional describe-cache optimizations
- More test coverage on exotic schema shapes (polymorphic lookups, junction objects with >2 sides)
- Doc improvements — always welcome

Open an issue first if it's bigger than a weekend of work, so we can align on the approach.
