// The Stock Network call log for Netlify functions (Jean, 2026-10-29). They
// have no Blobs store here, so each run collects its own Stock Network calls
// and hands them to /api/sn-log in one go (see edge-functions/lib/sn-log.js).
//   const log = callLog("Nightly property list");
//   const res = await log.fetch(url, init);   // like fetch(), and noted
//   await log.flush();                        // once, at the end of the run
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Same shape as callPath() in edge-functions/lib/sn-log.js, so both show alike.
function callPath(url) {
  let u; try { u = new URL(String(url)); } catch (_) { return "?"; }
  const host = u.hostname.startsWith("api.") ? "api" : u.hostname.startsWith("old.") ? "old site" : u.hostname.split(".")[0];
  return host + " " + u.pathname.replace(GUID, ":id").replace(/\/\d{3,}(?=\/|$)/g, "/:n");
}

export function callLog(source) {
  const calls = [];
  return {
    async fetch(url, init) {
      const t0 = Date.now(), at = new Date(t0).toISOString(), path = callPath(url);
      try {
        const res = await fetch(url, init);
        calls.push({ at, source, path, status: res.status, ms: Date.now() - t0 });
        return res;
      } catch (e) {
        calls.push({ at, source, path, status: 0, ms: Date.now() - t0 });
        throw e;
      }
    },
    async flush() {
      if (!calls.length) return;
      const records = calls.splice(0);
      try {
        const res = await fetch((process.env.URL || "https://go.avantetravel.co.za") + "/api/sn-log", {
          method: "POST",
          headers: { "content-type": "application/json", "x-pa-sync-secret": process.env.PA_SYNC_SECRET || "" },
          body: JSON.stringify({ action: "record", records }),
        });
        if (!res.ok) console.error("sn-call-log: the hub didn't take", records.length, "calls:", res.status);
      } catch (e) { console.error("sn-call-log: could not send", records.length, "calls:", e.message); }
    },
  };
}
