import type { OrgAuth } from "../auth/sf-auth.ts";
import type { DependencyGraph, EdgeAttrs } from "../graph/build.ts";
import { ApiError, UserError } from "../errors.ts";

/**
 * Low-level Salesforce REST calls used by `dry_run` and `run`.
 *
 * Everything here is allowed to touch record IDs and field values —
 * but the caller (the MCP tool handler) must never include returned
 * records / IDs in its `structuredContent` response to the LLM.
 * Records are persisted to session files on disk; only counts and
 * file paths are returned.
 */

/** `SELECT COUNT() FROM <object> [WHERE <clause>]` against `auth.instanceUrl`. */
export async function queryCount(opts: {
  auth: OrgAuth;
  object: string;
  whereClause?: string;
  fetchFn?: typeof fetch;
}): Promise<number> {
  const soql = opts.whereClause !== undefined && opts.whereClause.trim().length > 0
    ? `SELECT COUNT() FROM ${opts.object} WHERE ${opts.whereClause}`
    : `SELECT COUNT() FROM ${opts.object}`;

  const body = await queryAll(opts.auth, soql, opts.fetchFn);
  if (typeof body.totalSize === "number") return body.totalSize;
  throw new ApiError(
    `Unexpected response to COUNT query on ${opts.object}: ${JSON.stringify(body)}`,
  );
}

/**
 * Validate a user-supplied WHERE clause by asking Salesforce to count
 * matching rows. `MALFORMED_QUERY` (HTTP 400 with errorCode) surfaces
 * as a `UserError` so the AI can ask the user to fix their SOQL.
 */
export async function validateWhereClause(opts: {
  auth: OrgAuth;
  object: string;
  whereClause: string;
  fetchFn?: typeof fetch;
}): Promise<number> {
  try {
    return await queryCount(opts);
  } catch (err) {
    if (err instanceof ApiError && /MALFORMED_QUERY/i.test(err.message)) {
      throw new UserError(
        `Salesforce rejected your WHERE clause: ${err.message}`,
        `Fix the SOQL predicate and call sandbox_seed_seed with action: "start" again.`,
      );
    }
    throw err;
  }
}

/** Pull IDs for a SOQL query, following `nextRecordsUrl` until done. */
export async function queryIds(opts: {
  auth: OrgAuth;
  soql: string;
  fetchFn?: typeof fetch;
}): Promise<string[]> {
  const ids: string[] = [];
  let body = await queryAll(opts.auth, opts.soql, opts.fetchFn);
  accumulateIds(body, ids);
  while (body.done !== true && typeof body.nextRecordsUrl === "string") {
    body = await followNext(opts.auth, body.nextRecordsUrl, opts.fetchFn);
    accumulateIds(body, ids);
  }
  return ids;
}

/** Fetch full records for a SOQL query. Caller supplies explicit fields. */
export async function queryRecords(opts: {
  auth: OrgAuth;
  soql: string;
  fetchFn?: typeof fetch;
}): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  let body = await queryAll(opts.auth, opts.soql, opts.fetchFn);
  if (Array.isArray(body.records)) records.push(...(body.records as Array<Record<string, unknown>>));
  while (body.done !== true && typeof body.nextRecordsUrl === "string") {
    body = await followNext(opts.auth, body.nextRecordsUrl, opts.fetchFn);
    if (Array.isArray(body.records)) records.push(...(body.records as Array<Record<string, unknown>>));
  }
  return records;
}

/**
 * Resolve how each object in `finalObjectList` relates to the root, so
 * we can compose a scope-filtered COUNT or SELECT per object.
 *
 * Kinds:
 *   - root: the object equals root
 *   - direct-parent: root has an FK to this object (1 hop up)
 *   - direct-child: this object has an FK back to root (1 hop down)
 *   - transitive: reached via a chain of parent FKs (2+ hops up).
 *                 Requires ID materialization, not a single subquery.
 *   - unknown: no path from root in the graph — unseedable for this scope.
 */
export type ScopePathKind = "root" | "direct-parent" | "direct-child" | "transitive" | "unknown";

export type ScopePath = {
  object: string;
  kind: ScopePathKind;
  /** For direct-parent: the FK field on the root pointing to this object. */
  rootFk?: string;
  /** For direct-child: the FK field on this object pointing back to the root. */
  childFk?: string;
  /** For transitive: the chain of objects from this object up to the root. */
  chain?: string[];
};

export function computeScopePaths(
  graph: DependencyGraph,
  root: string,
  finalObjectList: string[],
): ScopePath[] {
  // Index edges by source/target for fast lookups.
  const edgesBySource = new Map<string, Array<{ target: string } & EdgeAttrs>>();
  const edgesByTarget = new Map<string, Array<{ source: string } & EdgeAttrs>>();
  for (const e of graph.edges) {
    const bySrc = edgesBySource.get(e.source) ?? [];
    bySrc.push(e);
    edgesBySource.set(e.source, bySrc);
    const byTgt = edgesByTarget.get(e.target) ?? [];
    byTgt.push(e);
    edgesByTarget.set(e.target, byTgt);
  }

  return finalObjectList.map((object): ScopePath => {
    if (object === root) return { object, kind: "root" };

    // Direct parent: root → object via some FK field on root.
    const rootOut = edgesBySource.get(root) ?? [];
    const direct = rootOut.find((e) => e.target === object && e.kind === "parent");
    if (direct !== undefined) {
      return { object, kind: "direct-parent", rootFk: direct.fieldName };
    }

    // Direct child: object → root via some FK field on object.
    const objectOut = edgesBySource.get(object) ?? [];
    const asChild = objectOut.find((e) => e.target === root && (e.kind === "child" || e.kind === "parent"));
    if (asChild !== undefined) {
      return { object, kind: "direct-child", childFk: asChild.fieldName };
    }

    // Transitive parent: BFS up the parent-edge chain from root until we
    // hit `object`. Stop after a modest bound so we don't explore forever.
    const chain = findParentChain(edgesBySource, root, object, 4);
    if (chain !== null) return { object, kind: "transitive", chain };

    return { object, kind: "unknown" };
  });
}

function findParentChain(
  edgesBySource: Map<string, Array<{ target: string } & EdgeAttrs>>,
  from: string,
  to: string,
  maxDepth: number,
): string[] | null {
  type Frame = { node: string; path: string[] };
  const queue: Frame[] = [{ node: from, path: [from] }];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const frame = queue.shift()!;
    if (frame.path.length > maxDepth + 1) continue;
    const outgoing = edgesBySource.get(frame.node) ?? [];
    for (const e of outgoing) {
      if (e.kind !== "parent") continue;
      if (seen.has(e.target)) continue;
      const nextPath = [...frame.path, e.target];
      if (e.target === to) return nextPath;
      seen.add(e.target);
      queue.push({ node: e.target, path: nextPath });
    }
  }
  return null;
}

/**
 * Chunk an ID list for SOQL `Id IN (...)` clauses. SOQL has a hard limit
 * around 4000 elements; we stay well below.
 */
export function chunkIds<T>(ids: T[], chunkSize = 500): T[][] {
  if (ids.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    out.push(ids.slice(i, i + chunkSize));
  }
  return out;
}

/** Quote an ID (or any literal) for inclusion in a SOQL `IN (...)` clause. */
export function soqlIdList(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
}

// ────────────────────────────────────────────────────────────────────
// Internal REST helpers
// ────────────────────────────────────────────────────────────────────

type QueryEnvelope = {
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
  records?: unknown;
};

async function queryAll(
  auth: OrgAuth,
  soql: string,
  fetchFn: typeof fetch = fetch,
): Promise<QueryEnvelope> {
  const url = `${auth.instanceUrl}/services/data/v${auth.apiVersion}/query?q=${encodeURIComponent(soql)}`;
  return await doGet(auth, url, fetchFn);
}

async function followNext(
  auth: OrgAuth,
  relativeUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<QueryEnvelope> {
  const url = relativeUrl.startsWith("http")
    ? relativeUrl
    : `${auth.instanceUrl}${relativeUrl}`;
  return await doGet(auth, url, fetchFn);
}

async function doGet(
  auth: OrgAuth,
  url: string,
  fetchFn: typeof fetch,
): Promise<QueryEnvelope> {
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    throw new ApiError(
      `Authentication rejected by Salesforce (HTTP 401).`,
      `Token may be expired. Run \`sf org login web --alias ${auth.alias ?? auth.username}\` to refresh.`,
    );
  }
  if (!res.ok) {
    const body = await safeText(res);
    throw new ApiError(
      `Salesforce API error ${res.status} ${res.statusText}.\n${body}`,
    );
  }

  try {
    return (await res.json()) as QueryEnvelope;
  } catch (err) {
    throw new ApiError(
      `Salesforce returned a non-JSON response: ${(err as Error).message}`,
    );
  }
}

function accumulateIds(body: QueryEnvelope, out: string[]): void {
  if (!Array.isArray(body.records)) return;
  for (const r of body.records) {
    if (r !== null && typeof r === "object" && "Id" in r) {
      const id = (r as { Id?: unknown }).Id;
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
