import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUpsertKeys, saveUpsertKeys, upsertKeysPath } from "../../src/seed/upsert-key-store.ts";

/**
 * The sticky upsert-key store: object → field NAMES per (source, target)
 * pair, beside the project id-map. Re-seeds match on the SAME external-id
 * the original run used instead of re-running auto-pick (T14 follow-up).
 */

describe("upsert-key store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "upsert-keys-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pair = () => ({
    sourceAlias: "Full Copy Sandbox",
    targetAlias: "DevTarget",
    rootDir: root,
  });

  it("path sits beside the project id-map with the same alias sanitization", () => {
    expect(upsertKeysPath(pair())).toBe(
      join(root, "id-maps", "Full_Copy_Sandbox__DevTarget.upsert-keys.json"),
    );
  });

  it("round-trips picks and merges per object (last write wins)", async () => {
    await saveUpsertKeys(pair(), { Contact: "SIS_Id__c", Account: "Ext__c" });
    await saveUpsertKeys(pair(), { Contact: "Other__c", Case: "Ref__c" });

    expect(await loadUpsertKeys(pair())).toEqual({
      Contact: "Other__c",
      Account: "Ext__c",
      Case: "Ref__c",
    });
  });

  it("returns {} for a missing file and never throws on corrupt content", async () => {
    expect(await loadUpsertKeys(pair())).toEqual({});

    const path = upsertKeysPath(pair());
    await saveUpsertKeys(pair(), { Contact: "X__c" });
    await writeFile(path, "{not json", "utf8");
    expect(await loadUpsertKeys(pair())).toEqual({});
  });

  it("drops non-string entries on load", async () => {
    const path = upsertKeysPath(pair());
    await saveUpsertKeys(pair(), { Contact: "X__c" });
    await writeFile(path, JSON.stringify({ Contact: "X__c", Bad: 42, Empty: "" }), "utf8");
    expect(await loadUpsertKeys(pair())).toEqual({ Contact: "X__c" });
  });

  it("save with no entries is a no-op (no file created)", async () => {
    await saveUpsertKeys(pair(), {});
    await expect(readFile(upsertKeysPath(pair()), "utf8")).rejects.toThrow();
  });

  it("keys files for different pairs do not collide", async () => {
    const other = { sourceAlias: "prod", targetAlias: "qa", rootDir: root };
    await saveUpsertKeys(pair(), { Contact: "A__c" });
    await saveUpsertKeys(other, { Contact: "B__c" });

    expect(await loadUpsertKeys(pair())).toEqual({ Contact: "A__c" });
    expect(await loadUpsertKeys(other)).toEqual({ Contact: "B__c" });
  });
});
