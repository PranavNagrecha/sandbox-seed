import type { OrgAuth } from "../auth/sf-auth.ts";
import { ApiError, UserError } from "../errors.ts";
import type { DescribeCache } from "./cache.ts";
import type { GlobalDescribe, SObjectDescribe } from "./types.ts";

export type DescribeClientOptions = {
  auth: OrgAuth;
  cache: DescribeCache;
  /** Injected for tests. If provided, used instead of real HTTP. */
  fetchFn?: typeof fetch;
};

/**
 * Thin REST describe client. Deliberately not using jsforce's describe wrapper:
 * we only need two endpoints and we want total control over errors and caching.
 *
 * Endpoints (relative to instanceUrl):
 *   GET /services/data/v<N>/sobjects/               → global describe
 *   GET /services/data/v<N>/sobjects/<Object>/describe/ → object describe
 */
export class DescribeClient {
  private readonly auth: OrgAuth;
  private readonly cache: DescribeCache;
  private readonly fetchFn: typeof fetch;
  private globalCache: GlobalDescribe | null = null;

  constructor(opts: DescribeClientOptions) {
    this.auth = opts.auth;
    this.cache = opts.cache;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async describeGlobal(): Promise<GlobalDescribe> {
    if (this.globalCache !== null) return this.globalCache;
    const url = `${this.auth.instanceUrl}/services/data/v${this.auth.apiVersion}/sobjects/`;
    const res = await this.get<GlobalDescribe>(url);
    this.globalCache = res;
    return res;
  }

  async describeObject(name: string): Promise<SObjectDescribe> {
    const cached = await this.cache.get(name);
    if (cached !== null) return cached;

    const url = `${this.auth.instanceUrl}/services/data/v${this.auth.apiVersion}/sobjects/${encodeURIComponent(
      name,
    )}/describe/`;

    const raw = await this.get<SObjectDescribe>(url);
    const normalized = normalizeDescribe(raw);
    await this.cache.set(name, normalized);
    return normalized;
  }

  /** Describe many objects. Sequential — Salesforce throttles parallel describes anyway. */
  async describeMany(names: string[]): Promise<Map<string, SObjectDescribe>> {
    const out = new Map<string, SObjectDescribe>();
    for (const name of names) {
      out.set(name, await this.describeObject(name));
    }
    return out;
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.auth.accessToken}`,
        Accept: "application/json",
      },
    });

    if (res.status === 401) {
      throw new ApiError(
        `Authentication rejected by Salesforce (HTTP 401) at ${redact(url)}.`,
        `Your access token may be expired. Run \`sf org login web --alias ${this.auth.alias ?? this.auth.username}\` to refresh.`,
      );
    }
    if (res.status === 404) {
      throw new UserError(
        `Not found: ${redact(url)}. The object may not exist in this org, or you lack permission.`,
      );
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new ApiError(
        `Salesforce API error ${res.status} ${res.statusText} at ${redact(url)}.\n${body}`,
      );
    }

    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new ApiError(
        `Salesforce returned a non-JSON response at ${redact(url)}: ${(err as Error).message}`,
      );
    }
  }
}

function normalizeDescribe(raw: SObjectDescribe): SObjectDescribe {
  const rawAny = raw as unknown as Record<string, unknown>;
  return {
    name: raw.name,
    label: raw.label,
    custom: raw.custom,
    queryable: raw.queryable,
    createable: raw.createable,
    fields: raw.fields.map((f) => {
      const fAny = f as unknown as Record<string, unknown>;
      const base = {
        name: f.name,
        label: typeof fAny.label === "string" ? (fAny.label as string) : undefined,
        nillable: f.nillable,
        custom: f.custom,
        calculated: fAny.calculated === true,
        defaultedOnCreate: fAny.defaultedOnCreate === true,
        createable: fAny.createable === true || fAny.createable === undefined,
        updateable: fAny.updateable === true || fAny.updateable === undefined,
        length: typeof fAny.length === "number" ? (fAny.length as number) : undefined,
        picklistValues: Array.isArray(fAny.picklistValues)
          ? (fAny.picklistValues as unknown[]).map((p) => {
              const pAny = p as Record<string, unknown>;
              return {
                value: String(pAny.value ?? ""),
                label: typeof pAny.label === "string" ? (pAny.label as string) : undefined,
                active: pAny.active !== false,
                defaultValue: pAny.defaultValue === true,
              };
            })
          : undefined,
        // Upsert-identity flags — captured verbatim from Salesforce describe.
        // Absent/falsey values normalize to `false`. `autoNumber` also derives
        // from `type === "autonumber"` because some older describes don't set
        // the flag explicitly on auto-number fields.
        externalId: fAny.externalId === true,
        unique: fAny.unique === true,
        idLookup: fAny.idLookup === true,
        autoNumber: fAny.autoNumber === true || f.type === "autonumber",
      };
      if (f.type === "reference") {
        return {
          ...base,
          type: "reference",
          referenceTo: ("referenceTo" in f && Array.isArray(f.referenceTo) ? f.referenceTo : []) as string[],
          relationshipName: ("relationshipName" in f ? f.relationshipName : null) ?? null,
          cascadeDelete: fAny.cascadeDelete === true,
        };
      }
      return { ...base, type: f.type };
    }),
    childRelationships: Array.isArray(rawAny.childRelationships)
      ? (rawAny.childRelationships as unknown[]).map((c) => {
          const cAny = c as Record<string, unknown>;
          return {
            childSObject: String(cAny.childSObject ?? ""),
            field: String(cAny.field ?? ""),
            relationshipName: typeof cAny.relationshipName === "string"
              ? (cAny.relationshipName as string)
              : null,
            cascadeDelete: cAny.cascadeDelete === true,
            restrictedDelete: cAny.restrictedDelete === true,
          };
        }).filter((c) => c.childSObject.length > 0 && c.field.length > 0)
      : undefined,
    recordTypeInfos: Array.isArray(rawAny.recordTypeInfos)
      ? (rawAny.recordTypeInfos as unknown[]).map((r) => {
          const rAny = r as Record<string, unknown>;
          return {
            developerName: String(rAny.developerName ?? rAny.name ?? ""),
            name: String(rAny.name ?? ""),
            recordTypeId: typeof rAny.recordTypeId === "string"
              ? (rAny.recordTypeId as string)
              : undefined,
            active: rAny.active !== false,
            master: rAny.master === true,
            available: rAny.available !== false,
          };
        })
      : undefined,
    urls: raw.urls,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function redact(url: string): string {
  return url.replace(/[?&](token|access_token)=[^&]+/g, "$1=REDACTED");
}
