// Every 10 minutes: read the next ~60 Stock Network resort pages for their
// unit types (sleeps, type), so the hub's location tree stays current. A full
// round of all properties takes about 15 hours, gently. The work happens in
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

export const config = { schedule: "*/10 * * * *" };
