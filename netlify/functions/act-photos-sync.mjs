// Every 2 minutes: give activities on the Avante map their main photo (map
// photo, else library, else Google), a few at a time, until all have been
// looked at; then only new activities. The work happens in /api/act-photos.
export default async () => {
  const base = process.env.URL || "https://go.avantetravel.co.za";
  const res = await fetch(base + "/api/act-photos", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pa-sync-secret": process.env.PA_SYNC_SECRET || "" },
    body: JSON.stringify({ action: "fill" }),
  });
  const text = await res.text();
  console.log("act-photos-sync", res.status, text.slice(0, 300));
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "*/2 * * * *" };
