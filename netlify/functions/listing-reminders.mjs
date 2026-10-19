// Every morning at 08:07 South African time (06:07 UTC): reminders to
// properties that haven't finished their listing, 1, 3, 5 and 10 days after
// their last save (Jean, 2026-10-19). The work happens in the
// /api/property-onboarding edge function (action remindListings); this only
// triggers it with the shared secret.
export default async () => {
  const base = process.env.URL || "https://go.avantetravel.co.za";
  const res = await fetch(base + "/api/property-onboarding", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pa-sync-secret": process.env.PA_SYNC_SECRET || "" },
    body: JSON.stringify({ action: "remindListings" }),
  });
  const text = await res.text();
  console.log("listing-reminders", res.status, text.slice(0, 2000));
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "7 6 * * *" };
