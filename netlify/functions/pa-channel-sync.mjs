// Every 15 minutes: read each connected property's channel calendars
// (Airbnb, Booking.com, LekkeSlaap), refresh its Stock Network availability,
// and book / cancel channel reservations on SN. The work happens in the
// /api/property edge function (where the Blobs store lives); this only
// triggers it with the shared secret.
export default async () => {
  const base = process.env.URL || "https://go.avantetravel.co.za";
  const res = await fetch(base + "/api/property", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pa-sync-secret": process.env.PA_SYNC_SECRET || "" },
    body: JSON.stringify({ action: "runSync" }),
  });
  const text = await res.text();
  console.log("pa-channel-sync", res.status, text.slice(0, 2000));
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "*/15 * * * *" };
