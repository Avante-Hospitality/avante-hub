// Every hour (Jean, 2026-10-19): read new properties, and any not read for 6
// months, from their Stock Network resort pages (35 a time) for their
// unit types (sleeps, type), so the hub's location tree stays current.
// Nothing due: no page is opened. The work happens in
// the /api/sn-units edge function (where the Blobs store lives).
export default async () => {
  const base = process.env.URL || "https://go.avantetravel.co.za";
  const res = await fetch(base + "/api/sn-units", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pa-sync-secret": process.env.PA_SYNC_SECRET || "" },
    body: JSON.stringify({ action: "refresh" }),
  });
  const text = await res.text();
  console.log("sn-units-sync", res.status, text.slice(0, 500));
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "23 * * * *" };
