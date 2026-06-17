// Renders each view with the LiquidJS harness + the real TRMNL framework CSS,
// then pixel-snapshots it in headless chromium. This is the "render it and look
// at it" layer — it catches visual regressions (layout, overflow, flag sizing)
// that the HTML-structure snapshots in test/render can't see.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { DEVICE, viewBox } from "../render/devices";
import { renderDocument } from "../render/harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../render/fixtures");

const VIEWS = ["full", "half_horizontal", "half_vertical", "quadrant"];
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

for (const fixture of fixtures) {
  const data = JSON.parse(readFileSync(`${FIXTURES}/${fixture}.json`, "utf8"));
  for (const view of VIEWS) {
    test(`${fixture} · ${view} · X`, async ({ page }) => {
      const device = DEVICE; // TRMNL X — the only supported device
      const box = viewBox(device, view); // full/half/quadrant slot dimensions
      const html = await renderDocument(view, data, device);
      await page.setViewportSize(box);
      // networkidle: wait for the trmnl.com CSS/JS + Inter font to load, just as
      // trmnlp does before it screenshots.
      await page.setContent(html, { waitUntil: "networkidle" });
      await page.evaluate(() => (document as any).fonts?.ready);
      // Give the framework's plugins.js a beat to fit/reveal text.
      await page.waitForTimeout(200);
      await expect(page.locator(".screen")).toHaveScreenshot(`${fixture}.${view}.x.png`);
    });
  }
}
