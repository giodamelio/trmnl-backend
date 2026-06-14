// trmnl-backend — entry/router.
//
// Each feed lives in src/features/<name>.ts and exposes a handler. Add a feed by
// dropping in a module and wiring one route below. Routes are versioned (/v1/…)
// so a feed's JSON shape can change without breaking already-deployed TRMNL
// plugins pinned to the old version. Shared, feed-agnostic helpers live in
// src/lib/. Per-feed query parsing and secrets stay inside each feed.

import type { Env } from "./env";
import { handleWorldCup } from "./features/worldcup";
import { errorResponse, json } from "./lib/response";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/v1/worldcup":
          return await handleWorldCup(url, env);
        case "/":
        case "/health":
          return json({ ok: true, endpoints: ["/v1/worldcup?tz=America/Los_Angeles"] });
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      return errorResponse("upstream_failed", 502, String(err));
    }
  },
} satisfies ExportedHandler<Env>;
