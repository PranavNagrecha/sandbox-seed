import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persistent per-(source, target) record of which upsert key each object
 * used, stored beside the project id-map at
 * `~/.sandbox-seed/id-maps/<source>__<target>.upsert-keys.json`.
 *
 * Why: the population-based auto-pick is deterministic for a given scope
 * (alphabetical tie-break), but two SESSIONS with different scopes — or
 * the same scope after source data drifts — can legitimately pick
 * different keys. A re-seed that matches on a different external-id than
 * the run that created the rows can stop matching them. Persisting the
 * pick makes re-seeds match on the SAME key until the user overrides it
 * (overrides always win and update the stored pick).
 *
 * Contents are object → field NAMES only — schema metadata, no values,
 * no record IDs. The store is consulted at dry-run (where the decision
 * is made and surfaced in the report) and written after a run completes.
 * Stored picks are re-validated against both describes on every read, so
 * schema drift degrades to a fresh auto-pick, never a broken upsert.
 */

export type UpsertKeyStoreOptions = {
  sourceAlias: string;
  targetAlias: string;
  /** Defaults to `~/.sandbox-seed`. Overridable for tests. */
  rootDir?: string;
};

function defaultRootDir(): string {
  return join(homedir(), ".sandbox-seed");
}

/** Same sanitization the project id-map uses, so the file sits beside it. */
function sanitizeAlias(alias: string): string {
  return alias.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function upsertKeysPath(opts: UpsertKeyStoreOptions): string {
  const root = opts.rootDir ?? defaultRootDir();
  const filename = `${sanitizeAlias(opts.sourceAlias)}__${sanitizeAlias(opts.targetAlias)}`;
  return join(root, "id-maps", `${filename}.upsert-keys.json`);
}

/** Load the stored picks. Missing or corrupt file ⇒ empty map, never throws. */
export async function loadUpsertKeys(opts: UpsertKeyStoreOptions): Promise<Record<string, string>> {
  try {
    const raw = await readFile(upsertKeysPath(opts), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [object, field] of Object.entries(parsed)) {
      if (typeof field === "string" && field.length > 0) out[object] = field;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge `entries` over the stored picks (last write wins per object) and
 * persist. Best-effort by design — callers treat failures as non-fatal,
 * the same stance the project id-map merge-back takes.
 */
export async function saveUpsertKeys(
  opts: UpsertKeyStoreOptions,
  entries: Record<string, string>,
): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const path = upsertKeysPath(opts);
  const existing = await loadUpsertKeys(opts);
  const merged = { ...existing, ...entries };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}
