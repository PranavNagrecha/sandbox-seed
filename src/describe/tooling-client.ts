import type { OrgAuth } from "../auth/sf-auth.ts";
import { ApiError } from "../errors.ts";
import { salesforceFetch } from "../salesforce-fetch.ts";

/**
 * Tooling API client, scoped to exactly what the validation-rule
 * toggle feature needs.
 *
 * We deliberately do NOT extend DescribeClient — that one is for the
 * regular `/sobjects/*` REST surface, and mixing the tooling endpoints
 * into it would blur the caching model. This client is stateless.
 *
 * Endpoints (relative to `instanceUrl`):
 *   GET   /services/data/v<N>/tooling/query?q=<SOQL>
 *   PATCH /services/data/v<N>/tooling/sobjects/ValidationRule/<id>
 *
 * Why the Metadata blob round-trip:
 *   `ValidationRule.Active` is read-only on the plain `sobjects/` surface.
 *   The mutable state lives in the `Metadata` field (a JSON blob with
 *   `active`, `errorConditionFormula`, `errorMessage`, `description`).
 *   To flip a rule off we PATCH the SAME metadata blob with `active: false`
 *   — preserving every other field so reactivation is byte-equivalent.
 */

export type ValidationRuleRecord = {
  /** Tooling-API record ID (03d…). */
  id: string;
  /** Short developer name, e.g. `SSN_Must_Be_9_Digits`. */
  validationName: string;
  /** Object the rule runs on, e.g. `Contact` or `MyCustom__c`. */
  entityApiName: string;
  /** Fully-qualified name, e.g. `Contact.SSN_Must_Be_9_Digits`. */
  fullName: string;
  /** Was the rule active at snapshot time? We only ever snapshot `true`. */
  active: boolean;
  /** Opaque metadata blob — we round-trip this untouched except for `active`. */
  metadata: Record<string, unknown>;
};

/**
 * Query every validation rule on the given objects that is currently
 * active in `auth`'s org. Rules on objects we don't seed are not returned.
 *
 * Two-phase because Salesforce Tooling API refuses SOQL results with
 * `Metadata` or `FullName` selected when there's more than one row —
 * it fails with `MALFORMED_QUERY: "the query qualifications must
 * specify no more than one row for retrieval"`. So:
 *
 *   1. Filter query — pulls `Id, ValidationName, Active,
 *      EntityDefinition.QualifiedApiName` (no Metadata/FullName). This
 *      returns N rows fine.
 *   2. Per-ID detail GET — `/tooling/sobjects/ValidationRule/<id>`
 *      returns the full record including `FullName` and the `Metadata`
 *      blob. One GET per rule. Done sequentially; Salesforce rate-limits
 *      parallel describes and we're already I/O-bound during run.
 */
export async function queryActiveValidationRules(opts: {
  auth: OrgAuth;
  objects: string[];
  fetchFn?: typeof fetch;
}): Promise<ValidationRuleRecord[]> {
  if (opts.objects.length === 0) return [];
  const fetchFn = opts.fetchFn ?? fetch;

  // Phase 1: filter query (no Metadata / FullName — those trigger the
  // single-row qualification rule).
  const inList = opts.objects
    .map((n) => `'${n.replace(/'/g, "\\'")}'`)
    .join(",");
  const soql =
    `SELECT Id, ValidationName, Active, EntityDefinition.QualifiedApiName ` +
    `FROM ValidationRule ` +
    `WHERE Active = true AND EntityDefinition.QualifiedApiName IN (${inList})`;

  const stubs: Array<{
    id: string;
    validationName: string;
    entityApiName: string;
  }> = [];

  let pageUrl: string | null =
    `${opts.auth.instanceUrl}/services/data/v${opts.auth.apiVersion}` +
    `/tooling/query?q=${encodeURIComponent(soql)}`;

  while (pageUrl !== null) {
    const res: Response = await salesforceFetch(fetchFn, pageUrl, {
      headers: {
        Authorization: `Bearer ${opts.auth.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new ApiError(
        `Tooling API query for ValidationRule failed (${res.status}): ${body}`,
        `If this says INSUFFICIENT_ACCESS or INVALID_SESSION, check that the target-org user ` +
          `has Customize Application; if this says MALFORMED_QUERY, it's an internal bug — ` +
          `this client deliberately avoids selecting Metadata/FullName in the filter query.`,
      );
    }
    const body = (await res.json()) as ToolingQueryEnvelope;
    for (const r of body.records ?? []) {
      if (r === null || typeof r !== "object") continue;
      const rr = r as Record<string, unknown>;
      const id = typeof rr.Id === "string" ? rr.Id : null;
      const validationName =
        typeof rr.ValidationName === "string" ? rr.ValidationName : null;
      let entityApiName: string | null = null;
      const ed = rr.EntityDefinition;
      if (ed !== null && typeof ed === "object") {
        const v = (ed as Record<string, unknown>).QualifiedApiName;
        if (typeof v === "string") entityApiName = v;
      }
      if (id !== null && validationName !== null && entityApiName !== null) {
        stubs.push({ id, validationName, entityApiName });
      }
    }
    pageUrl =
      body.done === true || typeof body.nextRecordsUrl !== "string"
        ? null
        : body.nextRecordsUrl.startsWith("http")
          ? body.nextRecordsUrl
          : `${opts.auth.instanceUrl}${body.nextRecordsUrl}`;
  }

  // Phase 2: per-ID GET to pull FullName + Metadata. Sequential — parallel
  // metadata fetches tend to hit Salesforce's tooling throttle.
  const out: ValidationRuleRecord[] = [];
  for (const stub of stubs) {
    const detailUrl =
      `${opts.auth.instanceUrl}/services/data/v${opts.auth.apiVersion}` +
      `/tooling/sobjects/ValidationRule/${encodeURIComponent(stub.id)}`;
    const res = await salesforceFetch(fetchFn, detailUrl, {
      headers: {
        Authorization: `Bearer ${opts.auth.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new ApiError(
        `Tooling GET ValidationRule/${stub.id} (${stub.entityApiName}.${stub.validationName}) ` +
          `failed (${res.status}): ${body}`,
      );
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const fullName =
      typeof raw.FullName === "string"
        ? raw.FullName
        : `${stub.entityApiName}.${stub.validationName}`;
    const metadata =
      raw.Metadata !== null && typeof raw.Metadata === "object"
        ? { ...(raw.Metadata as Record<string, unknown>) }
        : null;
    if (metadata === null) {
      // Record exists but has no Metadata blob — unexpected; skip.
      continue;
    }
    out.push({
      id: stub.id,
      validationName: stub.validationName,
      entityApiName: stub.entityApiName,
      fullName,
      active: raw.Active === true,
      metadata,
    });
  }

  return out;
}

/**
 * PATCH a validation rule's Metadata blob, toggling `active`. The rest of
 * the blob is preserved byte-for-byte from the snapshot — so reactivation
 * restores the exact prior state.
 */
export async function setValidationRuleActive(opts: {
  auth: OrgAuth;
  rule: ValidationRuleRecord;
  active: boolean;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url =
    `${opts.auth.instanceUrl}/services/data/v${opts.auth.apiVersion}` +
    `/tooling/sobjects/ValidationRule/${encodeURIComponent(opts.rule.id)}`;

  // Preserve every field from the snapshot, override only `active`.
  const metadata = { ...opts.rule.metadata, active: opts.active };

  const res = await salesforceFetch(fetchFn, url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${opts.auth.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      Metadata: metadata,
      FullName: opts.rule.fullName,
    }),
  });

  // Tooling metadata PATCH returns 204 on success in most API versions.
  if (!res.ok && res.status !== 204) {
    const body = await safeText(res);
    throw new ApiError(
      `Tooling PATCH ValidationRule/${opts.rule.id} (${opts.rule.fullName}) ` +
        `active=${opts.active} failed (${res.status}): ${body}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

type ToolingQueryEnvelope = {
  done?: boolean;
  nextRecordsUrl?: string;
  records?: unknown[];
};

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
