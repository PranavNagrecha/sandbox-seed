#!/usr/bin/env node
/**
 * T14 G1 — detector-recall probe. Metadata only: describes the given
 * objects on the source org and prints which fields the sensitive-field
 * detector flags, split into "will mask (text type)" vs "flagged but
 * non-maskable type (copies through in v1)". No SOQL on rows, no values.
 *
 * Usage:
 *   node scripts/probe-pii-detection.mjs <org-alias> Contact Case hed__Address__c
 */
import { execFileSync } from "node:child_process";
import { isSensitiveField } from "../dist/graph/filters.js";
import { MASKABLE_FIELD_TYPES } from "../dist/seed/mask/types.js";

const [alias, ...objects] = process.argv.slice(2);
if (!alias || objects.length === 0) {
  console.error("usage: node scripts/probe-pii-detection.mjs <org-alias> <Object> [Object…]");
  process.exit(2);
}

const out = execFileSync("sf", ["org", "display", "--target-org", alias, "--json"], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
const { accessToken, instanceUrl } = JSON.parse(out).result;

for (const object of objects) {
  const res = await fetch(`${instanceUrl}/services/data/v60.0/sobjects/${object}/describe/`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.log(`${object}: describe failed (HTTP ${res.status})`);
    continue;
  }
  const body = await res.json();
  const flagged = body.fields.filter((f) => isSensitiveField(f));
  const willMask = flagged.filter((f) => MASKABLE_FIELD_TYPES.has(f.type));
  const nonText = flagged.filter((f) => !MASKABLE_FIELD_TYPES.has(f.type));
  console.log(`\n${object} — ${flagged.length} flagged / ${willMask.length} will mask`);
  console.log(
    `  will mask : ${willMask.map((f) => `${f.name}(${f.type})`).join(", ") || "(none)"}`,
  );
  console.log(`  non-text  : ${nonText.map((f) => `${f.name}(${f.type})`).join(", ") || "(none)"}`);
}
