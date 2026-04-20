import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrgAuth } from "../../src/auth/sf-auth.ts";
import { seed } from "../../src/mcp/tools/seed.ts";
import { TOUCHED_VALIDATION_RULES_FILENAME } from "../../src/seed/validation-rule-toggle.ts";

/**
 * Global pending-recovery guard.
 *
 * The design contract: if any session directory under
 * `<sessionRoot>/sessions/*` holds a `touched-validation-rules.json`
 * file with a non-empty rules array, every action EXCEPT
 * `recover_validation_rules` is refused with a UserError. This
 * prevents a crash-induced "rules silently off" state from lingering
 * while the user kicks off new seed flows.
 */

function fakeAuth(alias: string): OrgAuth {
  return {
    username: `${alias}@x`,
    orgId: "00D000000000000AAA",
    accessToken: "fake",
    instanceUrl: `https://${alias}.my.salesforce.com`,
    apiVersion: "60.0",
    alias,
  };
}

describe("pending-recovery guard", () => {
  let sessionRoot: string;

  beforeEach(async () => {
    sessionRoot = await mkdtemp(join(tmpdir(), "seed-guard-"));
    // Seed a pending recovery on disk.
    const pendingDir = join(sessionRoot, "sessions", "2026-01-01-abandoned");
    await mkdir(pendingDir, { recursive: true });
    await writeFile(
      join(pendingDir, TOUCHED_VALIDATION_RULES_FILENAME),
      JSON.stringify({
        sessionId: "2026-01-01-abandoned",
        targetOrg: "acme-dev",
        snapshotAt: "2026-01-01T00:00:00Z",
        rules: [
          { id: "03d000000000001AAA", fullName: "Contact.R1", metadata: {} },
        ],
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(sessionRoot, { recursive: true, force: true });
  });

  it("refuses action: start while a prior session has deactivated rules", async () => {
    await expect(
      seed(
        {
          action: "start",
          sourceOrg: "src",
          targetOrg: "tgt",
          object: "Contact",
          whereClause: "Id != null",
        },
        {
          sessionRootDir: sessionRoot,
          authBySource: fakeAuth("src"),
          authByTarget: fakeAuth("tgt"),
        },
      ),
    ).rejects.toThrow(
      /Refusing new work.*validation rule\(s\) deactivated.*2026-01-01-abandoned/s,
    );
  });

  it("refuses action: analyze / select / dry_run / run with the same message", async () => {
    for (const action of ["analyze", "select", "dry_run", "run"] as const) {
      await expect(
        seed(
          {
            action,
            sessionId: "irrelevant",
            confirm: action === "run" ? true : undefined,
          },
          { sessionRootDir: sessionRoot },
        ),
      ).rejects.toThrow(/Refusing new work.*2026-01-01-abandoned/s);
    }
  });

  it("allows action: recover_validation_rules even while guard is active", async () => {
    // We don't need to successfully recover — we just need to confirm
    // that the guard itself doesn't block the recovery action. The
    // handler will fail later because there's no real session.json,
    // but not with the guard's "Refusing new work" message.
    const err = await seed(
      { action: "recover_validation_rules", sessionId: "2026-01-01-abandoned" },
      { sessionRootDir: sessionRoot },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // The error should be about session loading, NOT the guard.
    expect((err as Error).message).not.toMatch(/Refusing new work/);
  });
});
