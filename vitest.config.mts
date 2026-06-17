import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Two projects, two runtimes:
//   node   — plain Node. The pure worldcup logic (Layer 1, test/unit) and the
//            LiquidJS render harness (Layer 2, test/render). No workerd.
//   worker — Cloudflare's workers pool. Boots the Worker's fetch handler inside
//            workerd (the production runtime) for hermetic routing tests.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/render/**/*.test.ts", "test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
        },
      },
    ],
  },
});
