import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DescribeCache } from "../../src/describe/cache.ts";
import { ACCOUNT } from "../fixtures/describes.ts";

describe("DescribeCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seed-cache-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a describe through set/get", async () => {
    const cache = new DescribeCache({
      orgId: "00D000000000000AAA",
      ttlSeconds: 3600,
      cacheRoot: dir,
    });
    expect(await cache.get("Account")).toBeNull();
    await cache.set("Account", ACCOUNT);
    const got = await cache.get("Account");
    expect(got?.name).toBe("Account");
    expect(got?.fields.length).toBe(ACCOUNT.fields.length);
  });

  it("respects TTL", async () => {
    const cache = new DescribeCache({
      orgId: "00D000000000000AAA",
      ttlSeconds: 0, // instant expiry
      cacheRoot: dir,
    });
    await cache.set("Account", ACCOUNT);
    // With TTL 0, age > 0 immediately, so the entry is stale
    const got = await cache.get("Account");
    expect(got).toBeNull();
  });

  it("returns null and is a no-op when bypass=true", async () => {
    const cache = new DescribeCache({
      orgId: "00D000000000000AAA",
      ttlSeconds: 3600,
      cacheRoot: dir,
      bypass: true,
    });
    await cache.set("Account", ACCOUNT);
    expect(await cache.get("Account")).toBeNull();
  });

  it("isolates by orgId", async () => {
    const a = new DescribeCache({ orgId: "00D_A", ttlSeconds: 3600, cacheRoot: dir });
    const b = new DescribeCache({ orgId: "00D_B", ttlSeconds: 3600, cacheRoot: dir });
    await a.set("Account", ACCOUNT);
    expect(await b.get("Account")).toBeNull();
    expect(await a.get("Account")).not.toBeNull();
  });
});
