// Every hour (Jean, 2026-10-17): look on Stock Network for properties whose
// Avante Site Nr was sent but not set up yet. When one is found the hub marks
// it Set up, makes the property's (not yet connected) affiliate, links its
// listing and emails the property its hub login. The work happens in the
// /api/property-onboarding edge function (action checkWaitingSetUps); this
// only triggers it with the shared secret.
export default async () => {
  const base = process.env.URL || "https://go.avantetravel.co.za";
  const res = await fetch(base + "/api/property-onboarding", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pa-sync-secret": process.env.PA_SYNC_SECRET || "" },
    body: JSON.stringify({ action: "checkWaitingSetUps" }),
  });
  const text = await res.text();
  console.log("sn-setup-check", res.status, text.slice(0, 2000));
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

export const config = { schedule: "7 * * * *" };
