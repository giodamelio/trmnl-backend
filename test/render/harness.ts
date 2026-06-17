// Wraps a rendered view in the same HTML shell trmnlp (and production) use, so a
// browser renders it faithfully.
//
//   renderView()     — just the inner view HTML, for cheap deterministic HTML
//                      snapshots (no CSS needed; asserts markup/data wiring).
//   renderDocument() — the full HTML doc, mirroring trmnlp's render_html.erb
//                      byte-for-byte: the same trmnl.com framework CSS + JS and
//                      the same Inter font, so the browser renders exactly what
//                      trmnlp/production would. For Playwright pixel screenshots.
//                      (The framework's plugins.js does the text fitting/reveal,
//                      so it must be loaded — without it, text collapses.)
import { createEngine } from "./engine";
import type { DevicePreset } from "./devices";
import { DEVICE, viewBox } from "./devices";

// settings.yml pins framework_version: latest, and trmnlp's render_html.erb
// hardcodes the same. Keep these in lockstep with the deployed plugin.
const FRAMEWORK_VERSION = "latest";

const engine = createEngine();

export function renderView(view: string, data: Record<string, unknown>): Promise<string> {
  return engine.render(view, data);
}

/** Full standalone HTML document for browser rendering — a 1:1 copy of trmnlp's shell. */
export async function renderDocument(
  view: string,
  data: Record<string, unknown>,
  device: DevicePreset = DEVICE,
): Promise<string> {
  const inner = await renderView(view, data);
  const box = viewBox(device, view);
  const base = `https://trmnl.com`;
  return `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="${base}/css/${FRAMEWORK_VERSION}/plugins.css" />
    <script src="${base}/js/${FRAMEWORK_VERSION}/plugins.js"></script>
    <style>
      html, body { margin: 0; padding: 0; }
      /* Size the screen to this view's mashup slot (full/half/quadrant). */
      .screen { width: ${box.width}px; height: ${box.height}px; }
    </style>

    <!-- Begin Inter font -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap" rel="stylesheet">
    <!-- End Inter font -->
  </head>

  <body class="environment trmnl">
    <div class="${device.screenClasses}">
      <div class="view view--${view}">
${inner}
      </div>
    </div>
  </body>
</html>`;
}
