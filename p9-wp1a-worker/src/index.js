// P9 WP1A — Minimal Worker for B-01 closure verification.
// Allowed endpoints ONLY:
//   GET /health      -> { status: "ok", ts }
//   GET /version     -> { worker, version, ts }
//   GET /health/d1   -> read-only D1 smoke check (SELECT 1 AS ok) via DB binding
// NO business API. NO migration logic. NO production write.

const VERSION = "p9-wp1a-1.0.0";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ts = new Date().toISOString();

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", ts });
    }

    if (url.pathname === "/version") {
      return Response.json({
        worker: "jhzy-v2-api",
        version: VERSION,
        ts,
      });
    }

    if (url.pathname === "/health/d1") {
      try {
        const row = await env.DB.prepare("SELECT 1 AS ok").first();
        return Response.json({
          d1: "ok",
          bind: "DB",
          database: "jhzy-v2-db",
          ok: row ? row.ok : null,
          ts,
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ d1: "error", error: String(e), ts }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
