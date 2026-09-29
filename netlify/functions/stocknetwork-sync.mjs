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
// 2026-09-29 rewrite: previously this converted the API's rows into the same
// 8-column CSV shape the manual upload produces, then POSTed that as CSV
// text to /api/resorts -- lossy, since the API actually returns a much
// richer field set (Country, Area, District, Suburb, City, City2, State,
// ratings, resort code) than that 8-column shape kept. Per Jean's explicit
// instruction (2026-09-29): the API's fields should land in the hub as their
// own new raw fields, without ever touching the hub's own Zone/Town/Suburb
// tree (the hub is the master there -- driven purely by coordinate
// geocoding). Now posts the RAW API rows as JSON to the same /api/resorts
// endpoint, which resorts-api.js's new handleApiSync() routes to distinctly
// from a CSV upload (by Content-Type) -- it only UPDATES informational
// fields on properties that already exist in the hub (matched by
// StockNetwork's own ResortID), never creates a new resort-list row. A
// brand-new StockNetwork property only appears in the hub once a manual CSV
// upload (admin.html's existing "Choose file" flow) creates the row -- this
// nightly sync then keeps its informational fields current from there on.
//
// You can still use the manual CSV upload in admin.html any time -- this
// doesn't replace it. A CSV upload is still the only way to bring in
// brand-new properties, SiteID, and the amenity/policy columns the API
// doesn't return at all (WiFi, Parking, Pet Allowance, Allow Same Day
// Booking, Smoking Allowed, Checkin/Checkout Time, and the human-readable
// Property Type text) -- see resorts-api.js's parseResortsFromCsv for the
// full list.
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "syncStockNetworkApi", rows }),
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
      matchedProperties: importResult.matchedProperties,
      matchedRows: importResult.matchedRows,
      unmatchedApiRows: importResult.unmatchedApiRows,
      coordinatesChanged: importResult.coordinatesChanged,
      // Case A (full-hub-coordinate-geocoding-scope, 2026-09-29): of the
      // properties whose coordinate just changed, how many resorts-api.js's
      // handleApiSync managed to place into the hub's own
      // Zone/Town/Suburb/Nearby tree right away -- see that file for the
      // full logic. autoPlaceNoApiKey true means GOOGLE_GEOCODING_API_KEY
      // isn't set, so nothing was attempted at all this run.
      autoPlaced: importResult.autoPlaced,
      autoPlaceFailed: importResult.autoPlaceFailed,
      autoPlaceSkippedForTime: importResult.autoPlaceSkippedForTime,
      autoPlaceNoApiKey: importResult.autoPlaceNoApiKey,
      // Case B (full-hub-coordinate-geocoding-scope, 2026-09-29): of those
      // same just-changed coordinates, how many didn't look like they
      // matched the property's own name and got flagged for review in
      // admin.html's "StockNetwork location review" card (coordFlagCleared
      // is the reverse -- a coordinate that WAS flagged before and now
      // checks out again).
      coordFlaggedSuspicious: importResult.coordFlaggedSuspicious,
      coordFlagCleared: importResult.coordFlagCleared,
    },
    200
  );
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
