import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateSalt, saltPath } from "../../../src/seed/mask/salt.ts";

describe("masking salt store (T10)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "salt-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a 64-hex salt on first use, beside the id-map", async () => {
    const salt = await loadOrCreateSalt({ sourceAlias: "src", targetAlias: "tgt", rootDir: root });
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(saltPath({ sourceAlias: "src", targetAlias: "tgt", rootDir: root })).toBe(
      join(root, "id-maps", "src__tgt.salt"),
    );
  });

  it("is stable across calls — cross-run idempotence", async () => {
    const a = await loadOrCreateSalt({ sourceAlias: "src", targetAlias: "tgt", rootDir: root });
    const b = await loadOrCreateSalt({ sourceAlias: "src", targetAlias: "tgt", rootDir: root });
    expect(a).toBe(b);
  });

  it("differs per (source, target) pair", async () => {
    const a = await loadOrCreateSalt({ sourceAlias: "s1", targetAlias: "t", rootDir: root });
    const b = await loadOrCreateSalt({ sourceAlias: "s2", targetAlias: "t", rootDir: root });
    expect(a).not.toBe(b);
  });

  it("writes the salt file 0600 (secret at rest)", async () => {
    await loadOrCreateSalt({ sourceAlias: "src", targetAlias: "tgt", rootDir: root });
    const mode =
      (await stat(saltPath({ sourceAlias: "src", targetAlias: "tgt", rootDir: root }))).mode &
      0o777;
    expect(mode).toBe(0o600);
  });

  it("sanitizes aliases with spaces (real sandbox names like 'Excelsior FULL sandbox')", () => {
    expect(
      saltPath({ sourceAlias: "Excelsior FULL sandbox", targetAlias: "DevCaseInt", rootDir: root }),
    ).toBe(join(root, "id-maps", "Excelsior_FULL_sandbox__DevCaseInt.salt"));
  });
});
