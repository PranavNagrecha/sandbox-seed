#!/usr/bin/env node
// Local driver for Child+1 e2e test against real orgs.
// Bypasses the MCP subprocess (which runs stale dist); calls seed() directly.
//
// Usage: node --experimental-strip-types scripts/drive-child-lookup.ts <stage>
//   where <stage> is start|analyze|select|dry_run|run
//
// Session id is persisted to /tmp/seed-session.txt between invocations.

import { readFileSync, writeFileSync } from "node:fs";

import { seed } from "../dist/mcp/tools/seed.js";

// Config comes from env so no org identifiers are committed.
//   SEED_SOURCE_ORG   — sf alias of the source org
//   SEED_TARGET_ORG   — sf alias of the target sandbox
//   SEED_OBJECT       — root object (default: Contact)
//   SEED_WHERE        — SOQL WHERE predicate
//   SEED_CHILD_LOOKUPS — optional JSON, e.g. '{"Opportunity":["Pricebook2Id"]}'
const SOURCE = process.env.SEED_SOURCE_ORG;
const TARGET = process.env.SEED_TARGET_ORG;
const OBJECT = process.env.SEED_OBJECT ?? "Contact";
const WHERE = process.env.SEED_WHERE;
if (SOURCE === undefined || TARGET === undefined || WHERE === undefined) {
  process.stderr.write(
    "Missing env: set SEED_SOURCE_ORG, SEED_TARGET_ORG, SEED_WHERE (and optionally SEED_OBJECT, SEED_CHILD_LOOKUPS).\n",
  );
  process.exit(2);
}
const CHILD_LOOKUPS =
  process.env.SEED_CHILD_LOOKUPS !== undefined
    ? JSON.parse(process.env.SEED_CHILD_LOOKUPS)
    : undefined;
const SESSION_FILE = "/tmp/seed-child-lookup-session.txt";

const stage = process.argv[2] ?? "start";

async function main() {
  let sessionId;
  try {
    sessionId = readFileSync(SESSION_FILE, "utf8").trim();
  } catch {
    /* first run */
  }

  let resp;
  if (stage === "start") {
    resp = await seed({
      action: "start",
      sourceOrg: SOURCE,
      targetOrg: TARGET,
      object: OBJECT,
      whereClause: WHERE,
      sampleSize: 25,
      childLookups: CHILD_LOOKUPS,
    });
    writeFileSync(SESSION_FILE, resp.sessionId);
  } else if (stage === "analyze") {
    resp = await seed({
      action: "analyze",
      sessionId: sessionId,
      includeManagedPackages: true,
    });
  } else if (stage === "select") {
    // SEED_INCLUDE_CHILDREN — comma-separated object names to include as optional children.
    const childList =
      process.env.SEED_INCLUDE_CHILDREN !== undefined
        ? process.env.SEED_INCLUDE_CHILDREN.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    resp = await seed({
      action: "select",
      sessionId: sessionId,
      includeOptionalParents: [],
      includeOptionalChildren: childList,
    });
  } else if (stage === "dry_run") {
    resp = await seed({ action: "dry_run", sessionId: sessionId });
  } else if (stage === "run") {
    resp = await seed({ action: "run", sessionId: sessionId, confirm: true });
  } else {
    throw new Error(`unknown stage ${stage}`);
  }

  console.log(JSON.stringify(resp, null, 2));
}

main().catch((e) => {
  process.stderr.write(`ERROR: ${e?.stack ?? e}\n`);
  process.exit(1);
});
