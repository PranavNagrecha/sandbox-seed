import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPlaybooks, loadPlaybookByName } from "../../src/playbook/load.ts";

const VALID_YAML = `
apiVersion: sandbox-seed/v1
kind: Playbook
name: demo-refresh
description: Two-step demo
defaults:
  sourceOrg: prod
  targetOrg: dev
steps:
  - name: accounts
    object: Account
    whereClause: "Industry = 'Tech'"
  - name: contacts
    object: Contact
    whereClause: "Account.Industry = 'Tech'"
    limit: 50
`.trimStart();

describe("playbook/load", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pb-load-"));
    await mkdir(join(root, "playbooks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("listPlaybooks() returns [] when dir doesn't exist", async () => {
    const empty = await mkdtemp(join(tmpdir(), "pb-empty-"));
    try {
      const items = await listPlaybooks(empty);
      expect(items).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("listPlaybooks() finds and parses .yml files", async () => {
    await writeFile(join(root, "playbooks", "demo.yml"), VALID_YAML, "utf8");
    const items = await listPlaybooks(root);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("demo");
    expect(items[0].stepCount).toBe(2);
    expect(items[0].description).toBe("Two-step demo");
  });

  it("listPlaybooks() silently skips malformed YAML", async () => {
    await writeFile(join(root, "playbooks", "bad.yml"), "not: valid: yaml: at: all:", "utf8");
    await writeFile(join(root, "playbooks", "good.yml"), VALID_YAML, "utf8");
    const items = await listPlaybooks(root);
    expect(items.map((i) => i.name)).toEqual(["good"]);
  });

  it("loadPlaybookByName() round-trips a valid playbook", async () => {
    await writeFile(join(root, "playbooks", "demo.yml"), VALID_YAML, "utf8");
    const { playbook } = await loadPlaybookByName("demo", root);
    expect(playbook.name).toBe("demo-refresh");
    expect(playbook.steps).toHaveLength(2);
    expect(playbook.steps[1].limit).toBe(50);
    expect(playbook.defaults?.sourceOrg).toBe("prod");
  });

  it("loadPlaybookByName() throws UserError for unknown name", async () => {
    await expect(loadPlaybookByName("missing", root)).rejects.toThrow(
      /Playbook "missing" not found/,
    );
  });

  it("loadPlaybookByName() rejects path-unsafe names", async () => {
    await expect(loadPlaybookByName("../etc/passwd", root)).rejects.toThrow(
      /Invalid playbook name/,
    );
  });

  it("loadPlaybookByName() surfaces zod issues with field paths", async () => {
    await writeFile(
      join(root, "playbooks", "bad.yml"),
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: bad
steps: []
`.trimStart(),
      "utf8",
    );
    await expect(loadPlaybookByName("bad", root)).rejects.toMatchObject({
      message: expect.stringMatching(/failed schema validation/),
      hint: expect.stringContaining("steps"),
    });
  });

  it("loadPlaybookByName() rejects duplicate step names", async () => {
    await writeFile(
      join(root, "playbooks", "dupes.yml"),
      `
apiVersion: sandbox-seed/v1
kind: Playbook
name: dupes
steps:
  - name: x
    object: Account
    whereClause: "Id != null"
  - name: x
    object: Contact
    whereClause: "Id != null"
`.trimStart(),
      "utf8",
    );
    await expect(loadPlaybookByName("dupes", root)).rejects.toThrow(
      /duplicate step name "x"/,
    );
  });
});
