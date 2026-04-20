import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Persistent per-target-org id-map shared across seed runs.
 *
 * One file per (sourceAlias, targetAlias) pair under
 * `~/.sandbox-seed/id-maps/<source>__<target>.json`. JSON-shaped
 * identically to the per-session `id-map.json` used by `IdMap`:
 *
 *   { "<object>:<sourceId>": "<targetId>", ... }
 *
 * A sibling `.meta.json` records the target org's identity and
 * `LastRefreshDate`. If either changes (org swapped behind the alias,
 * or the sandbox was refreshed) the persisted map is treated as stale,
 * archived to `<file>.stale-<timestamp>.json`, and `load()` returns
 * an empty map.
 *
 * AI-boundary: the contents are source/target Salesforce IDs. Tool
 * responses must reference the file paths only, never the entries.
 */
export type ProjectIdMapMeta = {
  targetOrgId: string;
  /** ISO timestamp; null when the org has never been refreshed (rare). */
  targetLastRefreshDate: string | null;
  lastWrittenAt: string;
};

export type TargetIdentity = {
  orgId: string;
  lastRefreshDate: string | null;
};

export type ProjectIdMapOptions = {
  /** Defaults to `~/.sandbox-seed`. */
  rootDir?: string;
  sourceAlias: string;
  targetAlias: string;
};

export type LoadResult = {
  /** Map entries keyed `<object>:<sourceId>`. Empty when no map exists or it was invalidated. */
  entries: Record<string, string>;
  /** Populated when the persisted map was archived rather than loaded. */
  invalidated:
    | { reason: "org-refresh" | "org-mismatch" | "meta-corrupt"; archivedTo: string }
    | null;
};

export class ProjectIdMap {
  private readonly mapPath: string;
  private readonly metaPath: string;

  constructor(opts: ProjectIdMapOptions) {
    const root = opts.rootDir ?? defaultRootDir();
    const filename = `${sanitizeAlias(opts.sourceAlias)}__${sanitizeAlias(opts.targetAlias)}`;
    const dir = join(root, "id-maps");
    this.mapPath = join(dir, `${filename}.json`);
    this.metaPath = join(dir, `${filename}.meta.json`);
  }

  paths(): { mapPath: string; metaPath: string } {
    return { mapPath: this.mapPath, metaPath: this.metaPath };
  }

  /**
   * Load the persisted map. If the meta indicates the target org has
   * been refreshed (or replaced) since the map was last written, the
   * stale files are renamed aside and an empty result is returned.
   *
   * Missing files are not an error — a fresh map starts empty.
   */
  async load(currentTarget: TargetIdentity): Promise<LoadResult> {
    let mapRaw: string;
    try {
      mapRaw = await readFile(this.mapPath, "utf8");
    } catch {
      // No map yet. First run against this org pair.
      return { entries: {}, invalidated: null };
    }

    let meta: ProjectIdMapMeta | null = null;
    try {
      const metaRaw = await readFile(this.metaPath, "utf8");
      meta = JSON.parse(metaRaw) as ProjectIdMapMeta;
    } catch {
      // Map present but meta missing/corrupt — refuse to trust the map.
      const archivedTo = await this.archive("meta-corrupt");
      return { entries: {}, invalidated: { reason: "meta-corrupt", archivedTo } };
    }

    if (meta.targetOrgId !== currentTarget.orgId) {
      const archivedTo = await this.archive("org-mismatch");
      return { entries: {}, invalidated: { reason: "org-mismatch", archivedTo } };
    }

    if (
      meta.targetLastRefreshDate !== null &&
      currentTarget.lastRefreshDate !== null &&
      meta.targetLastRefreshDate !== currentTarget.lastRefreshDate
    ) {
      const archivedTo = await this.archive("org-refresh");
      return { entries: {}, invalidated: { reason: "org-refresh", archivedTo } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(mapRaw);
    } catch {
      // Map file unreadable — archive both and start fresh.
      const archivedTo = await this.archive("meta-corrupt");
      return { entries: {}, invalidated: { reason: "meta-corrupt", archivedTo } };
    }

    const entries: Record<string, string> = {};
    if (parsed !== null && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) entries[k] = v;
      }
    }
    return { entries, invalidated: null };
  }

  /**
   * Persist the merged set of entries plus a refreshed meta record.
   * Atomic: writes to a `.tmp` sibling then renames into place.
   */
  async save(entries: Record<string, string>, currentTarget: TargetIdentity): Promise<void> {
    await mkdir(dirOf(this.mapPath), { recursive: true });

    const meta: ProjectIdMapMeta = {
      targetOrgId: currentTarget.orgId,
      targetLastRefreshDate: currentTarget.lastRefreshDate,
      lastWrittenAt: new Date().toISOString(),
    };

    await atomicWriteJson(this.mapPath, entries);
    await atomicWriteJson(this.metaPath, meta);
  }

  /**
   * Merge `incoming` on top of the persisted map and write back.
   * Last-write-wins on key collisions (per BACKLOG decision, acceptable
   * because the more-recent target id is the authoritative one for a
   * given source row — a re-seed replaces the prior insert).
   */
  async merge(incoming: Record<string, string>, currentTarget: TargetIdentity): Promise<{
    sizeBefore: number;
    sizeAfter: number;
    invalidated: LoadResult["invalidated"];
  }> {
    const prior = await this.load(currentTarget);
    const merged: Record<string, string> = { ...prior.entries };
    let added = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v !== "string" || v.length === 0) continue;
      if (merged[k] !== v) added++;
      merged[k] = v;
    }
    await this.save(merged, currentTarget);
    return {
      sizeBefore: Object.keys(prior.entries).length,
      sizeAfter: Object.keys(merged).length,
      invalidated: prior.invalidated,
    };
  }

  /**
   * Move both `.json` and `.meta.json` aside with a timestamped suffix.
   * Returns the archived map path. Best-effort: if rename fails (file
   * was already gone, e.g. raced with another process) the failure is
   * swallowed so callers can proceed with an empty map.
   */
  private async archive(reason: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivedMap = `${this.mapPath}.stale-${stamp}.${reason}.json`;
    const archivedMeta = `${this.metaPath}.stale-${stamp}.${reason}.json`;
    await rename(this.mapPath, archivedMap).catch(() => {
      /* already gone */
    });
    await rename(this.metaPath, archivedMeta).catch(() => {
      /* already gone */
    });
    return archivedMap;
  }
}

function defaultRootDir(): string {
  return join(homedir(), ".sandbox-seed");
}

function sanitizeAlias(alias: string): string {
  // sf aliases are user-controlled. Strip anything that could escape the
  // filename boundary or confuse the `__` delimiter we use to join the
  // pair. Empty result falls back to a literal placeholder so the path
  // remains constructable.
  const cleaned = alias.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

function dirOf(path: string): string {
  const ix = path.lastIndexOf("/");
  return ix >= 0 ? path.slice(0, ix) : ".";
}

async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, targetPath);
}
