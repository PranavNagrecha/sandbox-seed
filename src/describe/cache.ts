import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SObjectDescribe } from "./types.ts";

const CACHE_ROOT = ".sandbox-seeding/cache";

/**
 * Bump this whenever the normalized describe shape changes in a way that
 * could silently corrupt older cache entries. E.g. adding a required
 * `childRelationships[]` path: describes cached before the normalizer
 * produced that key will deserialize with `childRelationships: undefined`
 * and the walk will silently produce an empty children set.
 *
 * Bumping here forces stale entries to miss on `get()` and refetch.
 */
const CACHE_SCHEMA_VERSION = 3;

export type CacheEntry = {
  /** Schema version of the cached `describe` payload. Missing = pre-v2, reject. */
  schema?: number;
  fetchedAt: number;
  describe: SObjectDescribe;
};

export type CacheOptions = {
  orgId: string;
  ttlSeconds: number;
  cacheRoot?: string;
  bypass?: boolean;
};

/**
 * Filesystem-backed describe cache. Keyed by org-id + object name.
 *
 * Layout: <cacheRoot>/<orgId>/<objectName>.json
 *
 * The cache is intentionally dumb: no schema-version invalidation (phase 2+),
 * just wall-clock TTL. Bypass with `bypass: true`.
 */
export class DescribeCache {
  private readonly dir: string;
  private readonly ttlMillis: number;
  private readonly bypass: boolean;

  constructor(opts: CacheOptions) {
    const root = opts.cacheRoot ?? CACHE_ROOT;
    this.dir = join(root, sanitizeOrgId(opts.orgId));
    this.ttlMillis = opts.ttlSeconds * 1000;
    this.bypass = opts.bypass ?? false;
  }

  async get(objectName: string): Promise<SObjectDescribe | null> {
    if (this.bypass) return null;
    const path = this.pathFor(objectName);
    try {
      const raw = await readFile(path, "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      // Reject any entry written under an older schema. Prevents the silent
      // "cached describe lacks childRelationships" failure we hit in smoke
      // testing on a long-lived cache.
      if ((entry.schema ?? 0) < CACHE_SCHEMA_VERSION) return null;
      const age = Date.now() - entry.fetchedAt;
      if (age > this.ttlMillis) return null;
      return entry.describe;
    } catch {
      return null;
    }
  }

  async set(objectName: string, describe: SObjectDescribe): Promise<void> {
    if (this.bypass) return;
    await mkdir(this.dir, { recursive: true });
    const entry: CacheEntry = {
      schema: CACHE_SCHEMA_VERSION,
      fetchedAt: Date.now(),
      describe,
    };
    await writeFile(this.pathFor(objectName), JSON.stringify(entry, null, 2), "utf8");
  }

  private pathFor(objectName: string): string {
    return join(this.dir, `${sanitizeObjectName(objectName)}.json`);
  }
}

function sanitizeOrgId(orgId: string): string {
  return orgId.replace(/[^a-zA-Z0-9]/g, "_");
}

function sanitizeObjectName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
