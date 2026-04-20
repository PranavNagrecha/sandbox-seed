import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectIdMap, type TargetIdentity } from "../../src/seed/project-id-map.ts";

const target: TargetIdentity = {
  orgId: "00D000000000001",
  lastRefreshDate: "2026-04-01T00:00:00.000Z",
};

describe("ProjectIdMap", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-id-map-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("load() returns empty when no map exists yet", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    const r = await m.load(target);
    expect(r.entries).toEqual({});
    expect(r.invalidated).toBeNull();
  });

  it("save() then load() round-trips entries", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    await m.save({ "Account:001A": "001a", "Contact:003C": "003c" }, target);
    const r = await m.load(target);
    expect(r.entries).toEqual({ "Account:001A": "001a", "Contact:003C": "003c" });
    expect(r.invalidated).toBeNull();
  });

  it("save() writes both map and meta files atomically", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    await m.save({ "Account:001": "001x" }, target);

    const { mapPath, metaPath } = m.paths();
    const mapRaw = await readFile(mapPath, "utf8");
    const metaRaw = await readFile(metaPath, "utf8");
    expect(JSON.parse(mapRaw)).toEqual({ "Account:001": "001x" });
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    expect(meta.targetOrgId).toBe(target.orgId);
    expect(meta.targetLastRefreshDate).toBe(target.lastRefreshDate);
    expect(typeof meta.lastWrittenAt).toBe("string");

    // No leftover .tmp- files in the id-maps dir.
    const dir = await readdir(join(root, "id-maps"));
    expect(dir.some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("merge() unions incoming with prior (last-write-wins on collisions)", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    await m.save({ "Account:001": "001a", "Contact:003C": "003c" }, target);

    const r = await m.merge(
      { "Account:001": "001a-NEW", "Contact:003D": "003d" },
      target,
    );
    expect(r.sizeBefore).toBe(2);
    expect(r.sizeAfter).toBe(3);

    const reloaded = await m.load(target);
    expect(reloaded.entries).toEqual({
      "Account:001": "001a-NEW",
      "Contact:003C": "003c",
      "Contact:003D": "003d",
    });
  });

  it("invalidates and archives when target LastRefreshDate changes", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    await m.save({ "Account:001": "001a" }, target);

    const refreshed: TargetIdentity = {
      orgId: target.orgId,
      lastRefreshDate: "2026-04-15T00:00:00.000Z",
    };
    const r = await m.load(refreshed);
    expect(r.entries).toEqual({});
    expect(r.invalidated?.reason).toBe("org-refresh");
    expect(r.invalidated?.archivedTo).toMatch(/\.stale-.*\.org-refresh\.json$/);

    const archived = await readFile(r.invalidated!.archivedTo, "utf8");
    expect(JSON.parse(archived)).toEqual({ "Account:001": "001a" });
  });

  it("invalidates when targetOrgId changes (alias swapped to a different org)", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    await m.save({ "Account:001": "001a" }, target);

    const swapped: TargetIdentity = {
      orgId: "00D000000000002",
      lastRefreshDate: target.lastRefreshDate,
    };
    const r = await m.load(swapped);
    expect(r.entries).toEqual({});
    expect(r.invalidated?.reason).toBe("org-mismatch");
  });

  it("invalidates when meta is missing but map is present", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    const dir = join(root, "id-maps");
    await mkdir(dir, { recursive: true });
    await writeFile(m.paths().mapPath, JSON.stringify({ "Account:001": "001a" }), "utf8");
    // No meta written.

    const r = await m.load(target);
    expect(r.entries).toEqual({});
    expect(r.invalidated?.reason).toBe("meta-corrupt");
  });

  it("does not invalidate when meta has null lastRefreshDate (org never refreshed)", async () => {
    const m = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    const noRefresh: TargetIdentity = { orgId: target.orgId, lastRefreshDate: null };
    await m.save({ "Account:001": "001a" }, noRefresh);

    const r = await m.load(noRefresh);
    expect(r.entries).toEqual({ "Account:001": "001a" });
    expect(r.invalidated).toBeNull();
  });

  it("scopes the file by (sourceAlias, targetAlias) pair", async () => {
    const a = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "dev" });
    const b = new ProjectIdMap({ rootDir: root, sourceAlias: "prod", targetAlias: "qa" });
    await a.save({ "Account:001": "001a" }, target);
    await b.save({ "Account:001": "001b" }, target);

    const ra = await a.load(target);
    const rb = await b.load(target);
    expect(ra.entries["Account:001"]).toBe("001a");
    expect(rb.entries["Account:001"]).toBe("001b");
  });

  it("sanitizes aliases that contain path-unsafe characters", async () => {
    const m = new ProjectIdMap({
      rootDir: root,
      sourceAlias: "prod/../escape",
      targetAlias: "dev space",
    });
    await m.save({ "Account:001": "001a" }, target);
    const { mapPath } = m.paths();
    expect(mapPath).not.toContain("..");
    expect(mapPath).not.toContain(" ");
    expect(mapPath).toContain("id-maps");
  });
});
