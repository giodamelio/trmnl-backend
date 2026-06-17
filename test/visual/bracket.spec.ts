// Visual snapshots of the knockout bracket SVG at each zoom level (R32→R16→QF→SF,
// outer→inner — the bracket auto-shrinks inward as rounds resolve). The bracket is
// a server-generated SVG the full view embeds in its right column; the fixtures in
// fixtures/bracket/ are captured from the Worker by generate.mjs.
//
// It MUST be embedded inline, not via <img>: an <img>-referenced SVG renders in
// "secure static mode" and can't load its hotlinked flagcdn flags (see the SVG
// embed note in CLAUDE.md / the plugin's <iframe> workaround). Inline SVG loads
// them like any other resource.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRACKETS = resolve(HERE, "../render/fixtures/bracket");

// The plugin embeds the bracket at the TRMNL X right-column width with the SVG's
// own 700×480 aspect (matches handleWorldCupBracketTest's 505px default).
const SLOT_W = 505;
const SLOT_H = Math.round((SLOT_W * 480) / 700);

const files = readdirSync(BRACKETS).filter((f) => f.endsWith(".svg"));

for (const file of files) {
  const name = file.replace(/\.svg$/, "");
  test(`bracket · ${name} · X`, async ({ page }) => {
    const svg = readFileSync(`${BRACKETS}/${file}`, "utf8");
    await page.setViewportSize({ width: SLOT_W, height: SLOT_H });
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
         html,body{margin:0;padding:0;overflow:hidden}
         #b{width:${SLOT_W}px;overflow:hidden}
         #b svg{width:100%;height:auto;display:block}
       </style></head><body><div id="b">${svg}</div></body></html>`,
      { waitUntil: "networkidle" }, // wait for the flagcdn flags
    );
    await expect(page.locator("#b")).toHaveScreenshot(`bracket.${name}.x.png`);
  });
}
