// Layer 1 (integration) — the Worker booted inside workerd (the production
// runtime) via @cloudflare/vitest-pool-workers. These are hermetic: they hit
// only routes that need no upstream, so they stay fast and offline while still
// proving the real router + response helpers work in workerd, not just Node.
//
// (Data-path behavior is covered by the pure-function tests in test/unit, which
// avoid the brittle outbound-fetch mocking the v4 pool no longer ships.)
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("router", () => {
  it("GET /health returns ok JSON", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("GET / advertises endpoints", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it("unknown paths 404", async () => {
    const res = await SELF.fetch("https://example.com/nope");
    expect(res.status).toBe(404);
  });

  it("the bracket test harness renders without an upstream", async () => {
    // handleWorldCupBracketTest is synchronous and self-contained (no ESPN).
    const res = await SELF.fetch("https://example.com/v1/worldcup/bracket-test");
    expect(res.status).toBe(200);
  });
});
