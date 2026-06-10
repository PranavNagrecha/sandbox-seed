#!/usr/bin/env node
/**
 * T14 cleanup — delete the target rows a seed session inserted.
 *
 * The acceptance-gate target is a shared working sandbox, not disposable: the gate
 * tracks every inserted target ID and removes it afterwards. Deletes are
 * scoped to THIS session's id-map, minus any entries that were already in
 * the project id-map before the run (pass the pre-run snapshot with
 * --baseline) — those targets belong to earlier seeds, not this gate.
 *
 * Guards:
 *   - the target org MUST be a sandbox (Organization.IsSandbox queried live);
 *   - children-first delete order (reverse of FK dependency) is not needed
 *     for the flat Contact gate, so deletes go object-by-object as listed;
 *   - output is counts + IDs only (Salesforce IDs are session metadata the
 *     id-map already exposes on disk; no field values are read or printed).
 *
 * Usage:
 *   node scripts/cleanup-seeded.mjs --session <session-id> [--baseline <project-map-snapshot.json>] [--restore-project-map]
 */
import { execFileSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function argOf(name) {
  const ix = args.indexOf(name);
  return ix >= 0 ? args[ix + 1] : undefined;
}
const SESSION_ID = argOf("--session");
const BASELINE = argOf("--baseline");
const RESTORE = args.includes("--restore-project-map");
if (!SESSION_ID) {
  console.error(
    "usage: node scripts/cleanup-seeded.mjs --session <id> [--baseline <snapshot.json>] [--restore-project-map]",
  );
  process.exit(2);
}

const SESSION_DIR = join(homedir(), ".sandbox-seed", "sessions", SESSION_ID);
const session = JSON.parse(await readFile(join(SESSION_DIR, "session.json"), "utf8"));
const idMapRaw = JSON.parse(await readFile(join(SESSION_DIR, "id-map.json"), "utf8"));

const baselineTargets = new Set();
if (BASELINE) {
  const snap = JSON.parse(await readFile(BASELINE, "utf8"));
  for (const v of Object.values(snap)) baselineTargets.add(v);
}

function orgAuth(alias) {
  const out = execFileSync("sf", ["org", "display", "--target-org", alias, "--json"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return { accessToken: parsed.result.accessToken, instanceUrl: parsed.result.instanceUrl };
}
const target = orgAuth(session.targetOrg);

async function rest(path, init = {}) {
  const res = await fetch(`${target.instanceUrl}/services/data/v60.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${target.accessToken}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

// Hard guard: refuse to delete anywhere that is not a sandbox.
{
  const res = await rest(
    `/query?q=${encodeURIComponent("SELECT IsSandbox FROM Organization LIMIT 1")}`,
  );
  const body = await res.json();
  if (body.records?.[0]?.IsSandbox !== true) {
    console.error("REFUSED: target org is not a sandbox. No deletes performed.");
    process.exit(1);
  }
}

// Collect this-run target ids per object (skip baseline-owned targets).
// RecordType entries are MAPPINGS to record types that already exist in the
// target — they were never inserted by the seed and must never be deleted.
const NEVER_DELETE = new Set(["RecordType", "User", "Group", "Queue"]);
const byObject = new Map();
for (const [key, tgtId] of Object.entries(idMapRaw)) {
  const ix = key.indexOf(":");
  if (ix <= 0) continue;
  const object = key.slice(0, ix);
  if (NEVER_DELETE.has(object)) continue;
  if (baselineTargets.has(tgtId)) continue;
  const list = byObject.get(object) ?? [];
  list.push(tgtId);
  byObject.set(object, list);
}

let deleted = 0;
let failed = 0;
for (const [object, ids] of byObject) {
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = await rest(`/composite/sobjects?ids=${chunk.join(",")}&allOrNone=false`, {
      method: "DELETE",
    });
    if (!res.ok) {
      console.error(`${object}: composite delete HTTP ${res.status}`);
      failed += chunk.length;
      continue;
    }
    const results = await res.json();
    for (const r of results) {
      if (r.success) deleted++;
      else {
        // ENTITY_IS_DELETED counts as fine — already gone.
        const codes = (r.errors ?? []).map((e) => e.statusCode);
        if (codes.includes("ENTITY_IS_DELETED")) deleted++;
        else {
          failed++;
          console.error(`${object}: delete failed for ${r.id}: ${codes.join(",") || "unknown"}`);
        }
      }
    }
  }
  console.log(`${object}: requested ${ids.length} delete(s)`);
}

if (RESTORE && BASELINE) {
  const mapPath = join(
    homedir(),
    ".sandbox-seed",
    "id-maps",
    `${sanitize(session.sourceOrg)}__${sanitize(session.targetOrg)}.json`,
  );
  await copyFile(BASELINE, mapPath);
  console.log(`project id-map restored from ${BASELINE}`);
}

// Mirrors sanitizeAlias in src/seed/project-id-map.ts / mask/salt.ts.
function sanitize(alias) {
  return alias.replace(/[^a-zA-Z0-9_-]/g, "_");
}

console.log(`deleted ${deleted} / failed ${failed}`);
process.exit(failed === 0 ? 0 : 1);
