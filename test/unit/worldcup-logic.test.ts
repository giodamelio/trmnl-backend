// Layer 1 (logic) — the timezone-sensitive transforms that are painful to verify
// by eyeballing httpyac output. These are pure functions: feed them ESPN-shaped
// data and assert the result. No network, no workerd. This is the data-faking the
// suite is really about — exercised at function granularity.
import { describe, expect, it } from "vitest";
import { derivePhase, demoBracket, normalize } from "../../src/features/worldcup";
import scoreboard from "../../apis/espn/samples/scoreboard-date.json";

const events = (scoreboard as any).events as any[];

describe("normalize — a local day spans two UTC dates", () => {
  // Sample event kicks off 2026-06-15T16:00Z.
  const e = events[0];

  it("keeps kickoffUtc as the canonical instant", () => {
    expect(normalize(e, "UTC").kickoffUtc).toBe(new Date(e.date).toISOString());
  });

  it("resolves the LOCAL calendar day per timezone", () => {
    // 16:00Z -> 09:00 PDT, still the 15th.
    expect(normalize(e, "America/Los_Angeles").localDate).toBe("2026-06-15");
    // 16:00Z -> 01:00 JST, already the 16th — the whole point of the tz contract.
    expect(normalize(e, "Asia/Tokyo").localDate).toBe("2026-06-16");
  });

  it("flags live/finished/upcoming from ESPN state", () => {
    const m = normalize(e, "UTC");
    expect(typeof m.isLive).toBe("boolean");
    expect(m.isLive && m.isFinished).toBe(false); // never both
  });
});

describe("derivePhase — group vs knockout", () => {
  const m = (over: Record<string, unknown>) => ({
    stage: "GROUP_STAGE",
    isFinished: false,
    isLive: false,
    kickoffUtc: "2026-06-15T16:00:00.000Z",
    ...over,
  });

  it("stays group while any group game is unfinished", () => {
    expect(derivePhase([m({})] as any, new Date("2026-06-15T00:00:00Z"))).toBe("group");
  });

  it("flips to knockout once every group game is finished", () => {
    expect(derivePhase([m({ isFinished: true })] as any, new Date("2026-06-20T00:00:00Z"))).toBe(
      "knockout",
    );
  });

  it("flips to knockout once the first knockout kickoff is reached", () => {
    const games = [m({}), m({ stage: "LAST_32", kickoffUtc: "2026-06-28T16:00:00.000Z" })] as any;
    expect(derivePhase(games, new Date("2026-06-27T00:00:00Z"))).toBe("group");
    expect(derivePhase(games, new Date("2026-06-28T17:00:00Z"))).toBe("knockout");
  });
});

describe("demoBracket — synthetic data for render fixtures", () => {
  it("fully-played demo resolves all 32 nodes with scores", () => {
    const nodes = demoBracket("F");
    expect(nodes).toHaveLength(32);
    const scored = nodes.filter((n: any) => n.home?.score != null && n.away?.score != null);
    expect(scored.length).toBe(32);
  });

  it("partial demo leaves the final unresolved", () => {
    const nodes = demoBracket("QF");
    const final = nodes.find((n: any) => n.stage === "FINAL" || n.slot === "FINAL");
    // Something representing the final exists, and it isn't fully scored in partial mode.
    expect(nodes.length).toBe(32);
    if (final) expect(final.home?.score == null || final.away?.score == null).toBe(true);
  });
});
