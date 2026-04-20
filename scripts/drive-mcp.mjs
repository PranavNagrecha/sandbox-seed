#!/usr/bin/env node
/**
 * End-to-end MCP smoke driver.
 *
 * Spawns `node bin/mcp.js`, speaks JSON-RPC over stdio, runs the 6 tools
 * from ACCEPTANCE.md against a real sandbox, and writes a structured
 * report. Does NOT go through an AI host — that's the point. It proves
 * the server works. Host-level acceptance (Claude actually choosing the
 * tools) is still a human task.
 *
 * Usage:
 *   node scripts/drive-mcp.mjs <org-alias> > phases/smoke-tests/YYYY-MM-DD-mcp-stdio.md
 */

import { spawn } from "node:child_process";
import { argv } from "node:process";

const ORG = argv[2];
if (!ORG) {
  console.error("usage: node scripts/drive-mcp.mjs <org-alias>");
  process.exit(2);
}

/** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
const child = spawn("node", ["./bin/mcp.js"], { stdio: ["pipe", "pipe", "pipe"] });

let stderrBuf = "";
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

/** Buffered line-oriented JSON-RPC reader. */
let stdoutBuf = "";
/** @type {Map<number, (msg: any) => void>} */
const pending = new Map();
child.stdout.on("data", (d) => {
  stdoutBuf += d.toString();
  while (true) {
    const nl = stdoutBuf.indexOf("\n");
    if (nl < 0) break;
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      process.stderr.write(`[driver] non-JSON stdout line: ${line}\n`);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 120_000) {
  const id = nextId++;
  const label = params?.name ? `${method}[${params.name}]` : method;
  const t0 = Date.now();
  process.stderr.write(`[driver] → ${label} (id=${id})\n`);
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${label} after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(t);
      process.stderr.write(`[driver] ← ${label} (${Date.now() - t0}ms)\n`);
      resolve(m);
    });
    child.stdin.write(JSON.stringify(msg) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function parseToolResult(resp) {
  if (resp.error) return { error: resp.error };
  const content = resp.result?.content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try {
    return { ok: JSON.parse(text), raw: text };
  } catch {
    return { ok: null, raw: text };
  }
}

const results = [];

function log(section) {
  results.push(section);
}

async function main() {
  // 1. initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "drive-mcp-smoke", version: "0.0.0" },
  });
  notify("notifications/initialized", {});

  log({ section: "initialize", serverInfo: init.result?.serverInfo, protocolVersion: init.result?.protocolVersion });

  // 2. tools/list
  const toolsList = await rpc("tools/list", {});
  const toolNames = (toolsList.result?.tools ?? []).map((t) => t.name);
  log({ section: "tools/list", names: toolNames });

  // 3. Prompt 1 — list_orgs (returns a bare array of OrgSummary)
  {
    const r = await rpc("tools/call", { name: "sandbox_seed_list_orgs", arguments: {} });
    const parsed = parseToolResult(r);
    const orgs = Array.isArray(parsed.ok) ? parsed.ok : (parsed.ok?.orgs ?? []);
    const targetPresent = orgs.some((o) => o.alias === ORG);
    const anyAccessToken = JSON.stringify(parsed.ok ?? {}).includes("accessToken");
    log({
      section: "prompt-1:list_orgs",
      tool: "sandbox_seed_list_orgs",
      orgCount: orgs.length,
      targetAliasPresent: targetPresent,
      leaksAccessToken: anyAccessToken,
      sampleOrgKeys: orgs[0] ? Object.keys(orgs[0]).sort() : [],
    });
  }

  // 4. Prompt 2 — check_ai_boundary
  {
    const r = await rpc("tools/call", { name: "sandbox_seed_check_ai_boundary", arguments: {} });
    const parsed = parseToolResult(r);
    const payload = parsed.ok ?? {};
    log({
      section: "prompt-2:check_ai_boundary",
      tool: "sandbox_seed_check_ai_boundary",
      keys: Object.keys(payload).sort(),
      willReturnCount: payload.willReturn?.length ?? 0,
      willNeverReturnCount: payload.willNeverReturn?.length ?? 0,
      whyNoExecuteSoqlFirst80: String(payload.whyNoExecuteSoql ?? "").slice(0, 80),
      competitorBullets: payload.contrastWithGeneralPurposeMcps ?? [],
    });
  }

  // 5. Prompt 3 — check_row_counts
  {
    const r = await rpc("tools/call", {
      name: "sandbox_seed_check_row_counts",
      arguments: { org: ORG, objects: ["Account", "Contact", "AccountNote__c"] },
    });
    const parsed = parseToolResult(r);
    log({
      section: "prompt-3:check_row_counts",
      tool: "sandbox_seed_check_row_counts",
      counts: parsed.ok?.counts ?? parsed,
    });
  }

  // 6. Prompt 4 — describe_global
  {
    const r = await rpc("tools/call", {
      name: "sandbox_seed_describe_global",
      arguments: { org: ORG },
    });
    const parsed = parseToolResult(r);
    const objects = parsed.ok?.objects ?? [];
    const custom = objects.filter((o) => o.custom);
    const hasAccountNote = custom.some((o) => o.name === "AccountNote__c");
    log({
      section: "prompt-4:describe_global",
      tool: "sandbox_seed_describe_global",
      totalObjects: objects.length,
      customCount: custom.length,
      accountNoteCustomPresent: hasAccountNote,
    });
  }

  // 7. Prompt 5 — describe_object AccountNote__c
  {
    const r = await rpc("tools/call", {
      name: "sandbox_seed_describe_object",
      arguments: { org: ORG, object: "AccountNote__c" },
    });
    const parsed = parseToolResult(r);
    const describe = parsed.ok?.describe ?? {};
    const fields = describe.fields ?? [];
    const md = fields.find((f) => f.name === "MD_Account__c");
    log({
      section: "prompt-5:describe_object[AccountNote__c]",
      tool: "sandbox_seed_describe_object",
      object: describe.name,
      fieldCount: fields.length,
      mdAccountField: md
        ? { name: md.name, type: md.type, referenceTo: md.referenceTo, cascadeDelete: md.cascadeDelete }
        : null,
      droppedFieldCounts: parsed.ok?.droppedFieldCounts ?? null,
    });
  }

  // 8. Prompt 6 — inspect_object Case + Support + counts
  {
    const r = await rpc("tools/call", {
      name: "sandbox_seed_inspect_object",
      arguments: {
        org: ORG,
        object: "Case",
        recordType: "Support",
        includeCounts: true,
        // Omit parentDepth to exercise the tool's default (2). ACCEPTANCE.md
        // prompts don't specify a depth, so the default is what users hit.
        includeChildren: true,
      },
    });
    const parsed = parseToolResult(r);
    if (parsed.error) {
      log({ section: "prompt-6:inspect_object[Case/Support]", error: parsed.error });
    } else {
      const g = parsed.ok ?? {};
      const nodes = g.graph?.nodes ?? [];
      const edges = g.graph?.edges ?? [];
      const cycles = g.cycles ?? [];
      const parentObjects = g.parentObjects ?? [];
      const childObjects = g.childObjects ?? [];
      const steps = g.loadPlan?.steps ?? [];
      const excluded = g.loadPlan?.excluded ?? [];

      const caseNode = nodes.find((n) => n.name === "Case");
      const requiredFieldNames = (caseNode?.requiredFields ?? []).map((f) => f.name).sort();
      const sensitiveNames = (caseNode?.sensitiveFields ?? []).map((f) => f.name).sort();

      // Child relationships live in edges with kind === "child".
      // Edge is source -> target where source is the referenced object
      // and target is the referencing child. (We check below.)
      const childEdges = edges.filter((e) => e.kind === "child");
      const accountNoteChildEdge = childEdges.find(
        (e) => (e.source === "Account" && e.target === "AccountNote__c") ||
               (e.target === "Account" && e.source === "AccountNote__c"),
      );
      const caseCommentChildEdge = childEdges.find(
        (e) => (e.source === "Case" && e.target === "CaseComment") ||
               (e.target === "Case" && e.source === "CaseComment"),
      );

      // Flatten load plan into an ordered list of object names for position checking.
      const orderedObjects = [];
      for (const s of steps) {
        if (s.kind === "single") orderedObjects.push(s.object);
        else if (s.kind === "cycle") orderedObjects.push(...(s.objects ?? []));
      }
      const accountIdx = orderedObjects.indexOf("Account");
      const noteIdx = orderedObjects.indexOf("AccountNote__c");

      // Find Priority_Custom__c in Case describe (it's a root field, not required).
      // The full node has fields in requiredFields/sensitiveFields — but the
      // full field list isn't on the node, only filtered. That's fine —
      // prompt 6b is the one that probes picklist values.
      log({
        section: "prompt-6:inspect_object[Case/Support]",
        tool: "sandbox_seed_inspect_object",
        rootObject: g.rootObject,
        recordTypeRequested: "Support",
        caseNodeRecordType: caseNode?.recordType ?? null,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        parentObjects: [...parentObjects].sort(),
        childObjects: [...childObjects].sort(),
        requiredFieldsOnCase: requiredFieldNames,
        sensitiveFieldsOnCase: sensitiveNames,
        accountNoteAppearsAsChildOfAccount: accountNoteChildEdge !== undefined,
        accountNoteChildEdge: accountNoteChildEdge ?? null,
        caseCommentAppearsAsChildOfCase: caseCommentChildEdge !== undefined,
        caseCommentChildEdge: caseCommentChildEdge ?? null,
        cyclesCount: cycles.length,
        cyclesSample: cycles.slice(0, 3).map((c) => ({ nodes: c.nodes, breakEdge: c.breakEdge })),
        loadStepsLength: steps.length,
        orderedObjects,
        excludedFromLoadPlan: excluded,
        accountIndex: accountIdx,
        accountNoteIndex: noteIdx,
        loadOrderCorrect: accountIdx >= 0 && noteIdx >= 0 && accountIdx < noteIdx,
        rowCountsPresent: nodes.some((n) => typeof n.rowCount === "number"),
        caseRowCount: caseNode?.rowCount ?? null,
        accountRowCount: nodes.find((n) => n.name === "Account")?.rowCount ?? null,
        contactRowCount: nodes.find((n) => n.name === "Contact")?.rowCount ?? null,
        allRowCounts: Object.fromEntries(
          nodes.map((n) => [n.name, n.rowCount ?? null]),
        ),
      });

      // Stash full inspect JSON separately for the parity diff.
      if (process.env.DRIVE_MCP_STASH_INSPECT) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(process.env.DRIVE_MCP_STASH_INSPECT, parsed.raw, "utf8");
      }
    }
  }

  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  emitReport();
}

function emitReport() {
  const lines = [];
  lines.push(`# MCP stdio smoke — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`**Org:** \`${ORG}\``);
  lines.push(`**Mode:** direct JSON-RPC stdio driver (no AI host in the loop)`);
  lines.push("");
  for (const r of results) {
    lines.push(`## ${r.section}`);
    lines.push("```json");
    lines.push(JSON.stringify(r, null, 2));
    lines.push("```");
    lines.push("");
  }
  if (stderrBuf) {
    lines.push("## server stderr");
    lines.push("```");
    lines.push(stderrBuf.trim());
    lines.push("```");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((e) => {
  process.stderr.write(`[driver] fatal: ${e.stack ?? e}\n`);
  results.push({ section: "FATAL", error: String(e.message ?? e) });
  try { emitReport(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  process.exit(1);
});
