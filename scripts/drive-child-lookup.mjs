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

const SOURCE = "prod-source";
const TARGET = "dev-target";
const OBJECT = "Contact";
const WHERE =
  "Id IN (SELECT hed__Applicant__c FROM hed__Application__c " +
  "WHERE hed__Application_Status__c IN ('Submitted', 'On Hold'))";
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
      childLookups: {
        Opportunity: ["Pricebook2Id"],
        hed__Application__c: ["hed__Applying_To__c"],
      },
    });
    writeFileSync(SESSION_FILE, resp.sessionId);
  } else if (stage === "analyze") {
    resp = await seed({
      action: "analyze",
      sessionId: sessionId,
      includeManagedPackages: true,
    });
  } else if (stage === "select") {
    resp = await seed({
      action: "select",
      sessionId: sessionId,
      includeOptionalParents: [],
      includeOptionalChildren: ["Opportunity", "hed__Application__c"],
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
