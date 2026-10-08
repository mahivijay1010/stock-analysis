/** M3: NSE bulk announcement / calendar parsing — publication timestamps, classification, malformed rows dropped. */
import { parseBulkAnnouncements, parseEventCalendar, parseNseStamp } from "../src/services/universe/AnnouncementIngestService";

describe("parseNseStamp", () => {
  test("IST timestamps and bare dates parse; garbage is null", () => {
    expect(parseNseStamp("08-Oct-2026 17:03:46")!.toISOString()).toBe("2026-10-08T11:33:46.000Z");
    expect(parseNseStamp("09-Oct-2026")!.toISOString()).toBe("2026-10-08T18:30:00.000Z");
    expect(parseNseStamp("")).toBeNull();
    expect(parseNseStamp("31-XYZ-2026")).toBeNull();
    expect(parseNseStamp("08102026170346")).toBeNull();
  });
});

describe("parseBulkAnnouncements", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    symbol: "NAGREEKEXP",
    desc: "Certificate under SEBI (Depositories and Participants) Regulations, 2018",
    an_dt: "08-Oct-2026 17:03:46",
    attchmntFile: "https://nsearchives.nseindia.com/corporate/x.pdf",
    attchmntText: "Nagreeka Exports Limited has informed the Exchange about Certificate",
    ...over,
  });
  test("keeps the publication timestamp as announcedAt and classifies by keywords", () => {
    const [a] = parseBulkAnnouncements([row()]);
    expect(a.symbol).toBe("NAGREEKEXP");
    expect(a.announcedAt.toISOString()).toBe("2026-10-08T11:33:46.000Z");
    expect(a.eventType).toBe("regulatory"); // "SEBI" keyword
    expect(a.url).toMatch(/^https/);
    const [r] = parseBulkAnnouncements([row({ desc: "Q2 FY27 results announcement", attchmntText: "quarterly results board approval" })]);
    expect(r.eventType).toBe("results");
    const [o] = parseBulkAnnouncements([row({ desc: "Trading window closure", attchmntText: "" })]);
    expect(o.eventType).toBe("other");
  });
  test("rows without symbol, description or timestamp are dropped; non-arrays yield []", () => {
    expect(parseBulkAnnouncements([row({ symbol: "" }), row({ desc: "", attchmntText: "" }), row({ an_dt: "garbage" })])).toHaveLength(0);
    expect(parseBulkAnnouncements({ not: "an array" })).toHaveLength(0);
  });
});

describe("parseEventCalendar", () => {
  test("results meetings are tagged results_calendar with the scheduled date; others board_meeting", () => {
    const rows = parseEventCalendar([
      { symbol: "ANANDRATHI", company: "x", purpose: "Financial Results/Dividend", bm_desc: "…", date: "09-Oct-2026" },
      { symbol: "ABC", purpose: "Fund Raising", date: "10-Oct-2026" },
      { symbol: "", purpose: "Financial Results", date: "10-Oct-2026" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: "ANANDRATHI", eventType: "results_calendar", meetingDate: "2026-10-09" });
    expect(rows[1].eventType).toBe("board_meeting");
  });
});
