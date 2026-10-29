// Admin > SN Calls (Jean, 2026-10-29): the Stock Network call log. See lib/sn-log.js.
//   POST { action: "summary", token, days }          admin: the page's numbers
//   POST { action: "saveLimits", token, perMinute, perHour }   admin: warning levels
//   POST { action: "record", records }  + x-pa-sync-secret     calls a Netlify function made
//                                        or x-hooks-secret     calls the hook builder made (HOOKS_SSO_SECRET)
//   POST { action: "rollUp" }           + x-pa-sync-secret     hourly (sn-log-rollup.mjs)
import { isAdminToken } from "./lib/admin-session.js";
import { summary, saveLimits, recordCalls, rollUp } from "./lib/sn-log.js";

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";

export default async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  let body = {}; try { body = await request.json(); } catch (_) { return json({ ok: false, error: "Send JSON." }, 400); }
  const a = String(body.action || "");
  try {
    if (a === "record" || a === "rollUp") {
      const secret = env("PA_SYNC_SECRET"), hooks = env("HOOKS_SSO_SECRET");
      const hub = !!secret && request.headers.get("x-pa-sync-secret") === secret;
      const builder = a === "record" && !!hooks && request.headers.get("x-hooks-secret") === hooks;
      if (!hub && !builder) return json({ ok: false, error: "forbidden" }, 403);
      if (a === "record") return json({ ok: true, logged: await recordCalls(body.records) });
      return json({ ok: true, result: await rollUp() });
    }
    if (!(await isAdminToken(body.token))) return json({ ok: false, error: "Log in to Admin again." }, 401);
    if (a === "summary") return json(Object.assign({ ok: true }, await summary(body.days)));
    if (a === "saveLimits") return json({ ok: true, limits: await saveLimits(body) });
    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (e) {
    console.error("sn-log-api", a, e);
    return json({ ok: false, error: "The call log couldn't be read: " + (e.message || e) }, 500);
  }
};

export const config = { path: "/api/sn-log" };
