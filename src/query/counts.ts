import type { OrgAuth } from "../auth/sf-auth.ts";
import { ApiError } from "../errors.ts";

/**
 * Opt-in row count fetch. Runs `SELECT COUNT() FROM <Object>` per object.
 *
 * AI-boundary note: `COUNT()` returns a single integer — aggregate metadata,
 * not record data. No field values, no record identifiers. Results are safe
 * to surface in output that AI may observe.
 *
 * Errors on any single object are swallowed (the object may be non-queryable
 * for this user) and absent from the returned map. The caller renders "—" or
 * similar for missing counts.
 */
export type FetchCountsOptions = {
  auth: OrgAuth;
  objects: string[];
  fetchFn?: typeof fetch;
};

export async function fetchRowCounts(opts: FetchCountsOptions): Promise<Map<string, number>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const out = new Map<string, number>();

  for (const name of opts.objects) {
    const soql = `SELECT COUNT() FROM ${name}`;
    const url = `${opts.auth.instanceUrl}/services/data/v${opts.auth.apiVersion}/query?q=${encodeURIComponent(soql)}`;

    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: {
          Authorization: `Bearer ${opts.auth.accessToken}`,
          Accept: "application/json",
        },
      });
    } catch {
      continue;
    }

    if (!res.ok) {
      if (res.status === 401) {
        throw new ApiError(
          `Authentication rejected while fetching row counts (HTTP 401).`,
          `Token may be expired. Re-run \`sf org login\`.`,
        );
      }
      continue;
    }

    try {
      const body = (await res.json()) as { totalSize?: number };
      if (typeof body.totalSize === "number") {
        out.set(name, body.totalSize);
      }
    } catch {
      continue;
    }
  }

  return out;
}
