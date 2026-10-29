// Every hour (Jean, 2026-10-29): fold the Stock Network call log's finished
// hours into day summaries (Admin > SN Calls). The work happens in the
// /api/sn-log edge function (where the Blobs store lives); this only
// triggers it with the shared secret.
export default async () => {
  const base = process.env.URL || "https://go.avantetravel.co.za";
  const res = await fetch(base + "/api/sn-log", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pa-sync-secret": process.env.PA_SYNC_SECRET || "" },
    body: JSON.stringify({ action: "rollUp" }),
  });
  const text = await res.text();
  console.log("sn-log-rollup", res.status, text.slice(0, 1000));
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "11 * * * *" };
