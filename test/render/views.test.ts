// Layer 2 — HTML snapshot tests. Renders each view against each fixture with our
// LiquidJS harness (no browser) and snapshots the markup. These are fast and
// deterministic: they catch template regressions and data-wiring bugs (a renamed
// field, a broken {% if %}, a dropped section) the moment they happen. Pixel
// fidelity is Layer 3's job (Playwright); this layer is about structure.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderView } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "fixtures");

const VIEWS = ["full", "half_horizontal", "half_vertical", "quadrant"];
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

describe("view rendering", () => {
  for (const fixture of fixtures) {
    const data = JSON.parse(readFileSync(`${FIXTURES}/${fixture}.json`, "utf8"));
    describe(fixture, () => {
      for (const view of VIEWS) {
        it(`${view} renders`, async () => {
          const html = await renderView(view, data);
          // Renders to non-trivial markup (catches a silently-empty render).
          expect(html.trim().length).toBeGreaterThan(0);
          // No unresolved Liquid errors leaked into the output.
          expect(html).not.toContain("Liquid error");
          await expect(html).toMatchFileSnapshot(
            `${HERE}/__snapshots__/${fixture}.${view}.html`,
          );
        });
      }
    });
  }
});
