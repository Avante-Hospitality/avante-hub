// Daily StockNetwork -> avante-hub resort-list sync.
//
// Confirmed via netlify/functions/stocknetwork-diagnostic.mjs (2026-09-28,
// since removed -- its job was done) that api.stocknetwork.co.za accepts
// these credentials fine from Netlify's own network, and that /api/1.0/resort
// rows carry real latitude/longitude on every row.
//
// Runs once a day, before reviewapp's own 03:00 UTC avante-hub-sync cron
// (see reviewapp/render.yaml) so reviewapp always pulls a same-day-fresh
// property list.
//
// Posts the RAW API rows as JSON to /api/resorts (resorts-api.js
// handleApiSync). Stock Network's own fields are refreshed on properties the
// hub has (matched by ResortID); properties the hub doesn't have yet are added
// (Jean, 2026-10-17, which replaced the old CSV upload). The hub's location
// tree stays the master for where a property is (Jean, 2026-09-29): Stock
// Network's coordinate is only taken for a property's first pin.
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

  // Step 3: post the RAW rows as JSON -- see resorts-api.js's handleApiSync
  // for exactly which fields it reads off each row and how it matches them
  // to existing hub properties.
  const siteBase = process.env.URL || "https://go.avantetravel.co.za";
  let importResp;
  try {
    importResp = await fetch(`${siteBase}/api/resorts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sync-secret": process.env.PA_SYNC_SECRET || "" }, // resorts-api.js checks this
      body: JSON.stringify({ action: "syncStockNetworkApi", rows }),
    });
  } catch (err) {
    return json({ ok: false, step: "import-post", error: String((err && err.message) || err) }, 502);
  }
  const importResult = await importResp.json().catch(() => null);
  if (!importResp.ok || !importResult || importResult.ok !== true) {
    return json({ ok: false, step: "import-post", status: importResp.status, received: importResult }, 502);
  }

  const summary = {
    ok: true,
    fetchedFromStockNetwork: rows.length,
    matchedProperties: importResult.matchedProperties,
    matchedRows: importResult.matchedRows,
    unmatchedApiRows: importResult.unmatchedApiRows,
    // Jean (2026-10-17): unmatched rows are now added to the hub (admin's
    // "Added from Stock Network"), except ones with no name or ones admin removed.
    addedProperties: importResult.addedProperties,
    skippedNoName: importResult.skippedNoName,
    skippedRemoved: importResult.skippedRemoved,
    coordinatesChanged: importResult.coordinatesChanged,
    // Name check of just-changed coordinates (resorts-api.js), and the
    // properties placed in the location tree this run.
    nameChecked: importResult.nameChecked,
    nameCheckSkippedForTime: importResult.nameCheckSkippedForTime,
    treePlace: importResult.treePlace,
    // Case B (full-hub-coordinate-geocoding-scope, 2026-09-29): of those
    // same just-changed coordinates, how many didn't look like they
    // matched the property's own name and got flagged for review in
    // admin.html's "StockNetwork location review" card (coordFlagCleared
    // is the reverse -- a coordinate that WAS flagged before and now
    // checks out again).
    coordFlaggedSuspicious: importResult.coordFlaggedSuspicious,
    coordFlagCleared: importResult.coordFlagCleared,
    // hub-is-master-for-location (2026-09-30): the hub is master for
    // Coordinates/Country/Zone/Town/Suburb once a property has ANY of
    // them -- StockNetwork only ever fills those in on a property's first
    // coordinate. This counts properties where the hub already had a
    // coordinate and StockNetwork's freshly-fetched one disagreed -- the
    // hub's own value was kept as-is and the property was flagged in
    // "StockNetwork location review" (same Accept-suggested-coordinate
    // flow as coordFlaggedSuspicious above) rather than overwritten.
    coordProtectedFromOverwrite: importResult.coordProtectedFromOverwrite,
    // SN cleanup wizard (2026-10-06): properties whose hub coordinate was
    // set ahead of StockNetwork's and is still waiting for StockNetwork to
    // match (kept, not flagged), and how many caught up on this run.
    coordAwaitingSn: importResult.coordAwaitingSn,
    snCoordCaughtUp: importResult.snCoordCaughtUp,
  };

  // 2026-09-30: print the result to the function's own log too -- Netlify's
  // scheduled-function log view only shows a duration/memory footer for each
  // run, not the HTTP response body, so without this line there was no way
  // for Jean to see what a nightly run actually did short of asking here.
  // console.log output on Netlify Functions IS captured in that log view.
  console.log("stocknetwork-sync result: " + JSON.stringify(summary));

  return json(summary, 200);
};

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
