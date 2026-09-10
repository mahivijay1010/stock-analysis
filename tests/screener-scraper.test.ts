/**
 * Screener scraper — number parsing + HTML extraction (pure, offline fixture).
 * The live fetch is exercised by scripts/verifyScreener.ts, not in CI.
 */

import { parseScreenerNumber } from "../src/services/intelligence/providers/ScreenerDataSource";

describe("parseScreenerNumber", () => {
  test.each([
    ["₹ 1,234 Cr.", 1234],
    ["32.5", 32.5],
    ["15.3 %", 15.3],
    ["1.2", 1.2],
    ["₹ 2,113", 2113],
    ["-4.5 %", -4.5],
    ["0.00", 0],
  ])("%s → %s", (raw, expected) => {
    expect(parseScreenerNumber(raw)).toBe(expected);
  });

  test("garbage ⇒ null", () => {
    expect(parseScreenerNumber("")).toBeNull();
    expect(parseScreenerNumber("N/A")).toBeNull();
    expect(parseScreenerNumber("--")).toBeNull();
  });
});
