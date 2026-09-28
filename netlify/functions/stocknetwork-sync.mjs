// Daily StockNetwork -> avante-hub resort-list sync.
//
// Confirmed via netlify/functions/stocknetwork-diagnostic.mjs (2026-09-28)
// that api.stocknetwork.co.za accepts these credentials fine from Netlify's
// own network (the earlier 403s were specific to a Claude sandbox's IP, not
// a real block) and that /api/1.0/resort rows carry real latitude/longitude
// on every row -- so this can populate the Map tab's coordinates directly,
// no separate geocoding step needed.
//
// Runs once a day, before reviewapp's own 03:00 UTC avante-hub-sync cron
// (see reviewapp/render.yaml) so reviewapp always pulls a same-day-fresh
// property list. Reuses the SAME POST /api/resorts endpoint the manual CSV
// upload in admin.html already calls -- so the existing merge-on-import
// logic (lib/resort-key.js: an admin-assigned affId survives this import,
// same as it survives a manual CSV re-upload) applies here automatically,
// with no separate code path to keep in sync.
//
// You can still use the manual CSV upload in admin.html any time -- this
// doesn't replace it, it just means you don't have to remember to run it
// for routine new-property updates.
//
// Manual test: hit this function's own URL with
// ?secret=<STOCKNETWORK_DIAG_SECRET> to run it on demand instead of
// waiting for the schedule.

export default async (request) => {
  const isScheduledInvocation = request.headers.get("x-netlify-event") === "schedule";
  if (!isScheduledInvocation) {
    const url = new URL(request.url);
    const suppliedSecret = url.searchParams.get("secret") || "";
    const expectedSecret = process.env.STOCKNETWORK_DIAG_SECRET || "";
    if (!expectedSecret || suppliedSecret !== expectedSecret) {
      return json({ ok: false, error: "Missing or wrong ?secret= (or call via the schedule)" }, 401);
    }
  }

  const username = process.env.STOCKNETWORK_USERNAME;
  const clientID = process.env.STOCKNETWORK_CLIENT_ID;
  const clientSecret = process.env.STOCKNETWORK_CLIENT_SECRET;
  if (!username || !clientID || !clientSecret) {
    return json({ ok: false, error: "Missing STOCKNETWORK_USERNAME / STOCKNETWORK_CLIENT_ID / STOCKNETWORK_CLIENT_SECRET" }, 500);
  }

  const base = "https://api.stocknetwork.co.za";

  // Step 1: authenticate.
  let tokenResp;
  try {
    tokenResp = await fetch(`${base}/api/1.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, clientID, clientSecret }),
    });
  } catch (err) {
    return json({ ok: false, step: "token", error: String((err && err.message) || err) }, 502);
  }
  if (!tokenResp.ok) {
    const preview = (await tokenResp.text()).slice(0, 500);
    return json({ ok: false, step: "token", status: tokenResp.status, bodyPreview: preview }, 502);
  }
  const tokenData = await tokenResp.json();
  const accessToken = tokenData.accessToken || tokenData.access_token;
  if (!accessToken) {
    return json({ ok: false, step: "token-shape", received: tokenData }, 502);
  }

  // Step 2: fetch the full resort master list.
  let resortResp;
  try {
    resortResp = await fetch(`${base}/api/1.0/resort`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch (err) {
    return json({ ok: false, step: "resort-fetch", error: String((err && err.message) || err) }, 502);
  }
  if (!resortResp.ok) {
    const preview = (await resortResp.text()).slice(0, 500);
    return json({ ok: false, step: "resort-fetch", status: resortResp.status, bodyPreview: preview }, 502);
  }
  const resortData = await resortResp.json();
  const rows = Array.isArray(resortData) ? resortData : resortData.resorts || resortData.data || [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ ok: false, step: "resort-shape", error: "No resort rows in the response", received: resortData }, 502);
  }

  // Step 3: turn it into the same CSV shape the manual upload in admin.html
  // produces, and feed it into the SAME /api/resorts endpoint that upload
  // calls -- see netlify/edge-functions/resorts-api.js's parseResortsFromCsv
  // for exactly which header names it looks for.
  const csv = toResortsCsv(rows);

  const siteBase = process.env.URL || "https://go.avantetravel.co.za";
  let importResp;
  try {
    importResp = await fetch(`${siteBase}/api/resorts`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csv,
    });
  } catch (err) {
    return json({ ok: false, step: "import-post", error: String((err && err.message) || err) }, 502);
  }
  const importResult = await importResp.json().catch(() => null);
  if (!importResp.ok || !importResult || importResult.ok !== true) {
    return json({ ok: false, step: "import-post", status: importResp.status, received: importResult }, 502);
  }

  return json(
    {
      ok: true,
      fetchedFromStockNetwork: rows.length,
      importedCount: importResult.count,
      updatedAt: importResult.updatedAt,
    },
    200
  );
};

function toResortsCsv(rows) {
  const header = ["Resort", "District", "Suburb", "State", "SiteID", "ResortID", "Latitude", "Longitude"];
  const lines = [header.join(",")];

  for (const r of rows) {
    const name = (r.resort_Name || r.resort_Name2 || "").trim();
    if (!name) continue; // parseResortsFromCsv skips nameless rows too -- matching that here

    const district = (r.district || r.area || "").trim();
    const suburb = (r.suburb || "").trim();
    const state = (r.state || "").trim();
    const siteId = ""; // not present on this StockNetwork endpoint -- resortId alone still uniquely keys each row
    const resortId = (r.iExchangeResortFileID || "").trim();
    const latitude = typeof r.latitude === "number" ? String(r.latitude) : "";
    const longitude = typeof r.longitude === "number" ? String(r.longitude) : "";

    lines.push(
      [name, district, suburb, state, siteId, resortId, latitude, longitude].map(csvField).join(",")
    );
  }

  return lines.join("\n");
}

function csvField(value) {
  const s = String(value ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 02:00 UTC daily -- one hour before reviewapp's own avante-hub-sync cron
// (03:00 UTC, see reviewapp/render.yaml), so reviewapp always pulls a
// same-day-fresh property list.
export const config = { schedule: "0 2 * * *" };
