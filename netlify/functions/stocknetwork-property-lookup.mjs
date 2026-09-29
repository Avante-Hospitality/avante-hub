// One-off diagnostic — NOT part of the daily sync. Built 2026-09-29 to answer
// a direct question: what does StockNetwork's own API actually return for a
// couple of specific real properties, with every raw field intact (not the
// narrow name/district/suburb/state/id/lat/lng subset stocknetwork-sync.mjs
// picks out for the CSV-shaped import). Same auth pattern as
// stocknetwork-sync.mjs / stocknetwork-diagnostic.mjs — reuses the existing
// StockNetwork credentials, does not write anything anywhere.
//
// Gated by its own env var (CLAUDE_LOOKUP_SECRET) rather than reusing
// STOCKNETWORK_DIAG_SECRET, so this one-off file can be deleted later
// without touching the real diagnostic/sync setup.
//
// Usage: https://<your-site>/.netlify/functions/stocknetwork-property-lookup?secret=<CLAUDE_LOOKUP_SECRET>
//   optional &q=<search text> to look up something else (matches against
//   the full raw row, case-insensitive, so it'll find a hit in any field —
//   name, district, suburb, etc.). With no &q=, defaults to the two
//   properties asked about: "37 on anderson" (Pretoria) and "amed" (Bali,
//   covers whichever exact spelling StockNetwork uses for "Pukit Lipa"/
//   "Puri Lipah").
//
// Delete this file (and the CLAUDE_LOOKUP_SECRET env var) once it's served
// its purpose.

const DEFAULT_QUERIES = ["37 on anderson", "amed"];

export default async (request) => {
  const url = new URL(request.url);
  const suppliedSecret = url.searchParams.get("secret") || "";
  const expectedSecret = process.env.CLAUDE_LOOKUP_SECRET || "";
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return json({ ok: false, error: "Missing or wrong ?secret=" }, 401);
  }

  const username = process.env.STOCKNETWORK_USERNAME;
  const clientID = process.env.STOCKNETWORK_CLIENT_ID;
  const clientSecret = process.env.STOCKNETWORK_CLIENT_SECRET;
  if (!username || !clientID || !clientSecret) {
    return json({ ok: false, error: "Missing STOCKNETWORK_USERNAME / STOCKNETWORK_CLIENT_ID / STOCKNETWORK_CLIENT_SECRET" }, 500);
  }

  const base = "https://api.stocknetwork.co.za";

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
  if (!Array.isArray(rows)) {
    return json({ ok: false, step: "resort-shape", error: "Not an array", received: resortData }, 502);
  }

  const qParam = url.searchParams.get("q");
  const queries = qParam ? [qParam] : DEFAULT_QUERIES;

  const results = queries.map((q) => {
    const needle = q.toLowerCase();
    const matches = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle)).slice(0, 20);
    return { query: q, matchCount: matches.length, matches };
  });

  return json(
    {
      ok: true,
      totalResortRowsReturnedByApi: rows.length,
      results,
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

export const config = { path: "/.netlify/functions/stocknetwork-property-lookup" };
