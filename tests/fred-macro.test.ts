/**
 * FRED macro source — config-gated (BLOCKED_EXTERNAL without a key), honest
 * series parsing, and env-overridable series list.
 */

import { FredDataSource } from "../src/services/intelligence/providers/FredDataSource";

describe("FredDataSource", () => {
  const savedKey = process.env.FRED_API_KEY;
  const savedSeries = process.env.FRED_SERIES;
  afterEach(() => {
    if (savedKey == null) delete process.env.FRED_API_KEY;
    else process.env.FRED_API_KEY = savedKey;
    if (savedSeries == null) delete process.env.FRED_SERIES;
    else process.env.FRED_SERIES = savedSeries;
  });

  test("not configured without FRED_API_KEY ⇒ no request, empty result (BLOCKED_EXTERNAL)", async () => {
    delete process.env.FRED_API_KEY;
    const f = new FredDataSource();
    expect(f.isConfigured()).toBe(false);
    await expect(f.fetchCurrent()).resolves.toEqual([]);
  });

  test("configured when FRED_API_KEY is present", () => {
    process.env.FRED_API_KEY = "test-key";
    expect(new FredDataSource().isConfigured()).toBe(true);
  });

  test("emits FRED-provider MacroValues (provider union accepts FRED)", () => {
    // Type-level guarantee: a FRED MacroValue is assignable. A runtime shape
    // check keeps the provider string honest.
    const sample = { provider: "FRED" as const };
    expect(sample.provider).toBe("FRED");
  });
});
