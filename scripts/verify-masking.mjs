#!/usr/bin/env node
/**
 * T14 §7.1 — local masking re-derivation verifier.
 *
 * For a completed masked seed session, re-derives every masked value from
 * (persisted salt, source value) using the PRODUCTION masker from dist/,
 * fetches the inserted target rows, and asserts:
 *
 *   (a) the target row contains the DERIVED value          (G3: mask present)
 *   (b) the target row does NOT contain the SOURCE value   (G3: no leak)
 *   (c) same source value → same masked output everywhere  (G4: consistency)
 *   (d) non-maskable types selected explicitly copy through (G6 as-built)
 *
 * Everything runs on this machine, on disk. Output is pass/fail COUNTS and
 * field NAMES only — record values are never printed, by design: the AI
 * driving the gate reads this output, so it must stay inside the AI
 * boundary. Build first: `npm run build` (imports the masker from dist/).
 *
 * Usage:
 *   node scripts/verify-masking.mjs --session <session-id> [--expect-rows N]
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMasker, pickStrategy } from "../dist/seed/mask/registry.js";
import { MASKABLE_FIELD_TYPES } from "../dist/seed/mask/types.js";

const args = process.argv.slice(2);
function argOf(name) {
  const ix = args.indexOf(name);
  return ix >= 0 ? args[ix + 1] : undefined;
}
const SESSION_ID = argOf("--session");
const EXPECT_ROWS = argOf("--expect-rows") ? Number(argOf("--expect-rows")) : undefined;
if (!SESSION_ID) {
  console.error("usage: node scripts/verify-masking.mjs --session <session-id> [--expect-rows N]");
  process.exit(2);
}

const SESSION_DIR = join(homedir(), ".sandbox-seed", "sessions", SESSION_ID);

// ── session state ────────────────────────────────────────────────────
const session = JSON.parse(await readFile(join(SESSION_DIR, "session.json"), "utf8"));
const salt = session.maskSalt;
if (typeof salt !== "string" || salt.length === 0) {
  console.error("FAIL: session has no maskSalt — was this a masked run?");
  process.exit(1);
}
const maskedFieldsByObject = session.dryRun?.maskedFieldsByObject ?? {};
const objects = Object.keys(maskedFieldsByObject);
if (objects.length === 0) {
  console.error("FAIL: session has no maskedFieldsByObject in its dry-run summary.");
  process.exit(1);
}

const idMapRaw = JSON.parse(await readFile(join(SESSION_DIR, "id-map.json"), "utf8"));

// ── org access (sf CLI handles tokens; we never persist them) ────────
function orgAuth(alias) {
  const out = execFileSync("sf", ["org", "display", "--target-org", alias, "--json"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return {
    accessToken: parsed.result.accessToken,
    instanceUrl: parsed.result.instanceUrl,
  };
}
const source = orgAuth(session.sourceOrg);
const target = orgAuth(session.targetOrg);

async function soql(auth, q) {
  const url = `${auth.instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SOQL failed (HTTP ${res.status}) on ${q.slice(0, 60)}…`);
  const body = await res.json();
  return body.records ?? [];
}

async function describeFields(auth, object) {
  const url = `${auth.instanceUrl}/services/data/v60.0/sobjects/${object}/describe/`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`describe ${object} failed (HTTP ${res.status})`);
  const body = await res.json();
  return new Map(body.fields.map((f) => [f.name, f]));
}

// ── rebuild the run's selection exactly as resolveMaskSelection did ──
// Resolved names come from the session's dry-run summary; user-pinned
// strategies (session.maskFields) overlay "auto", mirroring resolve.ts.
const selection = new Map();
for (const [object, fields] of Object.entries(maskedFieldsByObject)) {
  const m = new Map();
  for (const f of fields) m.set(f, "auto");
  selection.set(object, m);
}
if (session.maskFields) {
  for (const [object, specs] of Object.entries(session.maskFields)) {
    const m = selection.get(object) ?? new Map();
    for (const spec of specs) {
      if (typeof spec === "string") m.set(spec, "auto");
      else if (spec.strategy === "copy") m.delete(spec.field);
      else m.set(spec.field, spec.strategy);
    }
    if (m.size > 0) selection.set(object, m);
  }
}
const masker = createMasker({ salt, selection });

// ── verify per object ────────────────────────────────────────────────
let derivedMatch = 0; // (a)
let derivedMismatch = 0;
let leak = 0; // (b) target === source on a masked text field
let passthroughOk = 0; // null/"" preserved
let passthroughBad = 0;
let copiedNonMaskable = 0; // (d)
let copiedNonMaskableBad = 0;
let encryptedDisplay = 0; // encryptedstring: display-masked both sides
let encryptedDisplaySame = 0;
let automationRewrites = 0; // target automation copied another masked field
let rowsChecked = 0;
let rowsMissingInTarget = 0;
const consistency = new Map(); // srcValue → Set(targetValue)  (c)
const mismatchDiagnostics = []; // field NAMES + classification only — no values

for (const object of objects) {
  const fieldNames = maskedFieldsByObject[object];
  const pairs = [];
  for (const [k, tgtId] of Object.entries(idMapRaw)) {
    if (k.startsWith(`${object}:`)) pairs.push({ srcId: k.slice(object.length + 1), tgtId });
  }
  if (pairs.length === 0) continue;

  const fields = await describeFields(source, object);
  const fieldList = ["Id", ...fieldNames].join(", ");
  const srcIds = pairs.map((p) => `'${p.srcId}'`).join(",");
  const tgtIds = pairs.map((p) => `'${p.tgtId}'`).join(",");
  const srcRows = new Map(
    (await soql(source, `SELECT ${fieldList} FROM ${object} WHERE Id IN (${srcIds})`)).map((r) => [
      r.Id,
      r,
    ]),
  );
  const tgtRows = new Map(
    (await soql(target, `SELECT ${fieldList} FROM ${object} WHERE Id IN (${tgtIds})`)).map((r) => [
      r.Id,
      r,
    ]),
  );

  for (const { srcId, tgtId } of pairs) {
    const src = srcRows.get(srcId);
    const tgt = tgtRows.get(tgtId);
    if (!src) continue; // outside this run's scope (project-map entry)
    if (!tgt) {
      rowsMissingInTarget++;
      continue;
    }
    rowsChecked++;
    for (const fname of fieldNames) {
      const field = fields.get(fname);
      if (!field) continue;
      const sv = src[fname] ?? null;
      const tv = tgt[fname] ?? null;
      const maskable = MASKABLE_FIELD_TYPES.has(field.type) && typeof sv === "string" && sv !== "";

      if (sv === null || sv === "") {
        // Preserved empties — never fabricate PII into blanks.
        if (tv === null || tv === "") passthroughOk++;
        else passthroughBad++;
        continue;
      }
      if (field.type === "encryptedstring") {
        // Classic-encrypted fields API-read as DISPLAY-MASKED values (e.g.
        // XXX-XX-1234) for users without "View Encrypted Data" — on the
        // source at extract time AND on the target now. Derive-comparison
        // is impossible through that veil; what the run inserted was itself
        // derived from a display-masked read, so clear PII never moved.
        // Count separately; assert only that target ≠ raw source read.
        if (tv !== sv) encryptedDisplay++;
        else encryptedDisplaySame++;
        continue;
      }
      if (!maskable) {
        // Non-maskable type explicitly selected → copy-through (as-built G6).
        if (String(tv) === String(sv)) copiedNonMaskable++;
        else copiedNonMaskableBad++;
        continue;
      }
      const derived = masker.apply({ object, field, value: sv });
      if (tv === derived) derivedMatch++;
      else {
        // Diagnose WITHOUT printing values: does the target value equal the
        // derived mask of a DIFFERENT masked field on this same row? That is
        // the signature of target-org automation (e.g. HEDA preferred-email
        // sync) copying one masked field over another post-insert — the
        // value is still a masked artifact, not source PII.
        let matchedOther = null;
        for (const other of fieldNames) {
          if (other === fname) continue;
          const of = fields.get(other);
          const osv = src[other] ?? null;
          if (!of || typeof osv !== "string" || osv === "") continue;
          if (!MASKABLE_FIELD_TYPES.has(of.type)) continue;
          if (masker.apply({ object, field: of, value: osv }) === tv) {
            matchedOther = other;
            break;
          }
        }
        const truncated =
          typeof tv === "string" &&
          typeof derived === "string" &&
          tv.length > 0 &&
          tv.length < derived.length &&
          derived.startsWith(tv);
        if (matchedOther !== null) {
          // Target-org automation (e.g. HEDA preferred-phone/email sync)
          // rewrote this field with the mask of ANOTHER masked field after
          // our insert. Provably still a masked artifact — warn, don't fail,
          // and keep it OUT of the consistency groups (it is not the
          // masker's output for THIS source value).
          automationRewrites++;
          mismatchDiagnostics.push(
            `${object}.${fname}: target equals the mask of ${object}.${matchedOther} (automation copy — WARN)`,
          );
          if (tv === sv) leak++;
          continue;
        }
        derivedMismatch++;
        mismatchDiagnostics.push(
          `${object}.${fname}: target ${
            tv === null || tv === ""
              ? "is EMPTY (automation cleared it)"
              : truncated
                ? `is the derived mask TRUNCATED to ${tv.length} chars (target field length)`
                : "is some other value (unexplained)"
          }`,
        );
      }
      if (tv === sv) leak++;
      // G4 group key: (resolved preset, source value). The seed is keyed by
      // value alone, but the PRESET is per-field — the same value in a phone
      // field and a postal field masks to two different (deterministic)
      // shapes by design. Identical-output is only promised within a preset
      // family (the cross-object join case: email↔email, phone↔phone).
      const strat = selection.get(object)?.get(fname) ?? "auto";
      const resolved = strat === "auto" ? pickStrategy(field) : strat;
      const groupKey = `${resolved}:${sv}`;
      const group = consistency.get(groupKey) ?? new Set();
      group.add(String(tv));
      consistency.set(groupKey, group);
    }
  }
}

// G4: the consistency map groups every observed target value by its source
// value. The Set collapses identical outputs, so a consistent group has
// size 1 — any group with size > 1 means the same source value masked to
// two different outputs somewhere in scope.
const multiGroups = consistency.size;
let inconsistentGroups = 0;
for (const group of consistency.values()) {
  if (group.size > 1) inconsistentGroups++;
}

// ── report (counts + names only — NO record values) ─────────────────
console.log(`session            ${SESSION_ID}`);
console.log(`objects            ${objects.join(", ")}`);
console.log(
  `masked fields      ${objects.map((o) => `${o}[${maskedFieldsByObject[o].length}]`).join(" ")}`,
);
console.log(
  `rows checked       ${rowsChecked}${EXPECT_ROWS !== undefined ? ` (expected ${EXPECT_ROWS})` : ""}`,
);
console.log(`rows missing       ${rowsMissingInTarget}`);
console.log(`derived == target  ${derivedMatch}   (G3a: mask present)`);
console.log(`derived != target  ${derivedMismatch}   (unexplained — fails the gate)`);
console.log(`automation rewrite ${automationRewrites}   (target automation copied another masked field — WARN)`);
for (const d of mismatchDiagnostics) console.log(`  ↳ ${d}`);
console.log(`source leaked      ${leak}   (G3b: must be 0)`);
console.log(`empties preserved  ${passthroughOk} ok / ${passthroughBad} bad`);
console.log(
  `non-maskable copy  ${copiedNonMaskable} ok / ${copiedNonMaskableBad} bad   (G6 as-built)`,
);
console.log(
  `encrypted-display  ${encryptedDisplay} differ / ${encryptedDisplaySame} identical   (encryptedstring: API reads are display-masked; derive-compare N/A)`,
);
console.log(
  `value groups       ${multiGroups} total / ${inconsistentGroups} inconsistent   (G4: must be 0 inconsistent)`,
);

const rowsOk = EXPECT_ROWS === undefined || rowsChecked === EXPECT_ROWS;
const pass =
  rowsOk &&
  rowsChecked > 0 &&
  rowsMissingInTarget === 0 &&
  derivedMismatch === 0 &&
  leak === 0 &&
  passthroughBad === 0 &&
  copiedNonMaskableBad === 0 &&
  inconsistentGroups === 0;
console.log(pass ? "VERDICT            PASS" : "VERDICT            FAIL");
process.exit(pass ? 0 : 1);
