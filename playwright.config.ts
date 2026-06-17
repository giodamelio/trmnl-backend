import { defineConfig } from "@playwright/test";

// Layer 3 — pixel/visual snapshots of the self-rendered plugin views.
//
// The browser comes from Nix, NOT from `npx playwright install`: the devshell
// sets PLAYWRIGHT_BROWSERS_PATH to pkgs.playwright-driver.browsers and we pin
// @playwright/test to the same version as nixpkgs' playwright-driver (1.59.1) so
// the expected chromium revision (1217) is the one Nix provides. See flake.nix.
export default defineConfig({
  testDir: "./test/visual",
  // Keep baselines OS-agnostic in the path (we render headless chromium only).
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  // Snapshots are deterministic renders; a tiny tolerance absorbs antialiasing.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: { headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
