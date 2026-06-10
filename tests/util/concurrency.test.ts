import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/util/concurrency.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const items = [30, 5, 20, 1, 10];
    const results = await mapWithConcurrency(items, 5, async (ms) => {
      await sleep(ms);
      return ms * 2;
    });
    expect(results).toEqual([60, 10, 40, 2, 20]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(maxInFlight).toBe(3);
  });

  it("actually runs items concurrently (not sequentially)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4], 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10);
      inFlight--;
    });
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("propagates the first error and stops claiming new items", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 2, async (i) => {
        started.push(i);
        await sleep(5);
        if (i === 1) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
    // Workers stop claiming after the failure: with limit 2 and the error on
    // item 1, far fewer than all 10 items should ever have started.
    expect(started.length).toBeLessThan(10);
  });

  it("handles an empty input", async () => {
    const results = await mapWithConcurrency([], 4, async () => 1);
    expect(results).toEqual([]);
  });

  it("rejects a non-positive limit", async () => {
    await expect(mapWithConcurrency([1], 0, async (x) => x)).rejects.toThrow(RangeError);
  });

  it("passes the item index through", async () => {
    const results = await mapWithConcurrency(["a", "b", "c"], 2, async (item, i) => `${item}${i}`);
    expect(results).toEqual(["a0", "b1", "c2"]);
  });
});
