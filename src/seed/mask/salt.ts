import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persistent per-(source, target) masking salt.
 *
 * Lives beside the project id-map at `~/.sandbox-seed/id-maps/<src>__<tgt>.salt`
 * (chmod 600). Persisting it keeps masking deterministic across separate runs
 * against the same org pair — so re-seeds are idempotent and external-id UPSERT
 * keeps matching the rows a prior run masked. (masking-spec.md §4.5)
 *
 * The salt is a SECRET: it is never logged, and never returned in any tool
 * response. Only the masking engine (HMAC key) and session.json hold it.
 */
export type SaltOptions = {
  sourceAlias: string;
  targetAlias: string;
  /** Defaults to `~/.sandbox-seed`. Overridable for tests. */
  rootDir?: string;
};

function defaultRootDir(): string {
  return join(homedir(), ".sandbox-seed");
}

/** Same sanitization the project id-map uses, so the salt sits beside it. */
function sanitizeAlias(alias: string): string {
  return alias.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function saltPath(opts: SaltOptions): string {
  const root = opts.rootDir ?? defaultRootDir();
  const filename = `${sanitizeAlias(opts.sourceAlias)}__${sanitizeAlias(opts.targetAlias)}`;
  return join(root, "id-maps", `${filename}.salt`);
}

/**
 * Load the persistent salt for a (source, target) pair, creating it (CSPRNG) on
 * first use. Returns the 64-hex salt string.
 */
export async function loadOrCreateSalt(opts: SaltOptions): Promise<string> {
  const path = saltPath(opts);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // No salt yet — first masked run against this org pair.
  }
  const salt = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, salt, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Best-effort — some filesystems don't honor POSIX modes.
  }
  return salt;
}
