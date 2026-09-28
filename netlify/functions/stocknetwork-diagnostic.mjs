// One-off diagnostic — NOT the real sync. Visit this function's URL (with
// the secret) from a browser once StockNetwork's credentials are set as
// Netlify environment variables, and it answers two open questions without
// waiting on StockNetwork support:
//
//   1. Does StockNetwork's API actually accept these credentials from
//      Netlify's network? (We already know they 403 from the Claude
//      sandbox — this tells us whether that's IP-allowlisting specific to
//      that sandbox, or a problem with the credentials/request itself.)
//   2. What do the real fields on a /api/1.0/resort row look like —
//      in particular, is there any latitude/longitude on it at all? The
//      Map tab needs coordinates and StockNetwork's docs don't list any on
//      this endpoint, so this confirms it one way or the other before we
//      build the real sync against guessed field names.
//
// Delete this file once those questions are answered and the real sync
// (if any) is built from confirmed fields — it exists to answer them fast.
//
// Required env vars (Netlify site settings → Environment variables):
//   STOCKNETWORK_USERNAME
//   STOCKNETWORK_CLIENT_ID
//   STOCKNETWORK_CLIENT_SECRET
//   STOCKNETWORK_DIAG_SECRET   -- any random string you make up, just to
//                                  stop strangers from hitting this URL
//                                  and burning your StockNetwork credits.
//
// Usage: https://<your-site>.netlify.app/.netlify/functions/stocknetwork-diagnostic?secret=<STOCKNETWORK_DIAG_SECRET>
//   add &host=sandbox to hit testapi.stocknetwork.co.za instead of production.

export default async (request) => {
  const url = new URL(request.url);
  const suppliedSecret = url.searchParams.get("secret") || "";
  const expectedSecret = process.env.STOCKNETWORK_DIAG_SECRET || "";

  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return json({ ok: false, error: "Missing or wrong ?secret=" }, 401);
  }

  const username = process.env.STOCKNETWORK_USERNAME;
  const clientID = process.env.STOCKNETWORK_CLIENT_ID;
  const clientSecret = process.env.STOCKNETWORK_CLIENT_SECRET;
  if (!username || !clientID || !clientSecret) {
    return json(
      {
        ok: false,
        error:
          "One or more of STOCKNETWORK_USERNAME / STOCKNETWORK_CLIENT_ID / STOCKNETWORK_CLIENT_SECRET is not set in this Netlify site's environment variables.",
      },
      500
    );
  }

  const useSandbox = url.searchParams.get("host") === "sandbox";
  const base = useSandbox ? "https://testapi.stocknetwork.co.za" : "https://api.stocknetwork.co.za";

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

  const tokenBodyText = await tokenResp.text();
  if (!tokenResp.ok) {
    return json(
      {
        ok: false,
        step: "token",
        host: base,
        status: tokenResp.status,
        statusText: tokenResp.statusText,
        // First 500 chars only — a 403 page can be large HTML we don't need in full.
        bodyPreview: tokenBodyText.slice(0, 500),
        note:
          "Auth failed from Netlify's own network. If this is the same bare 403 seen from the Claude sandbox, that rules out sandbox-specific IP blocking as the sole cause.",
      },
      200
    );
  }

  let tokenData;
  try {
    tokenData = JSON.parse(tokenBodyText);
  } catch {
    return json({ ok: false, step: "token-parse", bodyPreview: tokenBodyText.slice(0, 500) }, 200);
  }

  const accessToken = tokenData.accessToken || tokenData.access_token;
  if (!accessToken) {
    return json({ ok: false, step: "token-shape", received: tokenData }, 200);
  }

  // Step 2: fetch the resort master list and show a small sample of the
  // RAW shape, so we can see real field names (and whether lat/lng exist)
  // before writing any mapping code against them.
  let resortResp;
  try {
    resortResp = await fetch(`${base}/api/1.0/resort`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch (err) {
    return json({ ok: true, authOk: true, step: "resort", error: String((err && err.message) || err) }, 200);
  }

  const resortBodyText = await resortResp.text();
  if (!resortResp.ok) {
    return json(
      {
        ok: true,
        authOk: true,
        step: "resort",
        status: resortResp.status,
        bodyPreview: resortBodyText.slice(0, 500),
      },
      200
    );
  }

  let resortData;
  try {
    resortData = JSON.parse(resortBodyText);
  } catch {
    return json({ ok: true, authOk: true, step: "resort-parse", bodyPreview: resortBodyText.slice(0, 500) }, 200);
  }

  const list = Array.isArray(resortData) ? resortData : resortData.resorts || resortData.data || [];

  return json(
    {
      ok: true,
      authOk: true,
      host: base,
      totalCount: Array.isArray(list) ? list.length : "not an array — see rawTopLevelKeys",
      rawTopLevelKeys: Array.isArray(resortData) ? null : Object.keys(resortData || {}),
      sampleRows: Array.isArray(list) ? list.slice(0, 3) : null,
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

export const config = { path: "/.netlify/functions/stocknetwork-diagnostic" };
