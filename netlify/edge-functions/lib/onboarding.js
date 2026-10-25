// Adding a property, step by step (Jean, 2026-10-25): one list of steps, in
// the order they get done, with whose turn each is. Admin > Property Listings
// > "Set up" shows it as a pop-up, and "What's outstanding?" lists what's left
// for one property or for all of them.
//
// Two paths:
//   channel: the property is on a channel manager (NightsBridge, eRes). Its
//            rooms, rates and calendar come from there.
//   hosted:  no channel manager. Avante holds its calendar and rates, and its
//            other channels (Airbnb, Booking.com, LekkeSlaap) link by iCal.
//
// A pure function, so it is easy to test: the caller (property-onboarding-api.js
// onboardingContext) reads the records and passes them in.
//
// Statuses: done, you (admin's turn), owner (the property's turn),
//           wait (waiting on Stock Network), later (an earlier step first).

const STEP_TITLES = {
  request: "The request",
  listing: "Listing details",
  siteNr: "Site Nr and set-up sheet",
  verify: "Check the site on Stock Network",
  location: "Location",
  rates: "Rates and calendar",
  sn: "Set up on Stock Network",
  connect: "Connect it",
  reviews: "Reviews",
  channels: "Channels (iCal)",
  owner: "The owner's part",
  golive: "Go live",
};
export const PATHS = {
  channel: ["request", "siteNr", "verify", "location", "connect", "reviews", "owner", "golive"],
  hosted: ["request", "listing", "location", "rates", "sn", "connect", "reviews", "channels", "owner", "golive"],
};
// The channels a property can link by iCal, as the List your property page names them.
export const ICAL_CHANNELS = ["Airbnb", "Booking.com", "LekkeSlaap"];

function has(v) { return String(v == null ? "" : v).trim() !== ""; }
function norm(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

export function pathOf(listing) {
  const l = listing || {};
  const cm = String(l.channelManager || "");
  if (l.channelProperty === "Y" || cm === "NightsBridge" || cm === "eRes/NebulaCRS" || has(l.bbid)) return "channel";
  return "hosted";
}

// Where the property said it is listed now: ["LekkeSlaap", ...] (iCal channels only).
export function listedChannels(listing) {
  const text = String((listing && listing.listedOn) || "");
  return ICAL_CHANNELS.filter((c) => text.toLowerCase().includes(c.toLowerCase()));
}

// The fields where Stock Network's location differs from the hub's (the hub's tree is master).
export function locationDiffs(listing, snRow) {
  if (!listing || !snRow) return [];
  const out = [];
  [["area", "Area (region)"], ["district", "District (municipality)"], ["suburb", "Suburb"], ["city", "City"]].forEach(([k, label]) => {
    if (has(listing[k]) && norm(listing[k]) !== norm(snRow[k])) out.push({ field: k, label, hub: listing[k], sn: snRow[k] || "" });
  });
  return out;
}

// c: {
//   listing,                     the listing record
//   entry,                       its Site Nrs register entry, or null
//   snRow,                       its row in the hub's Stock Network list, or null
//   aff,                         its hub affiliate record, or null
//   hasPassword,                 the affiliate has chosen a password
//   pa: { connected, settings, channelLinks: { "LekkeSlaap": n }, pendingChannelBookings,
//         channelHelp, frontStoreOn } or null,
//   readyTodo: [labels]          ListingReady.todo(listing) for a hosted listing
// }
export function onboardingSteps(c) {
  const l = c.listing || {}, e = c.entry || null, row = c.snRow || null, pa = c.pa || null;
  const path = pathOf(l);
  const status = {}, note = {};
  const set = (id, s, n) => { status[id] = s; note[id] = n || ""; };

  // 1 The request: who Avante talks to.
  const contactOk = has(l.contactEmail || l.email) && has(l.contactPhone || l.telephone);
  set("request", contactOk ? "done" : "you", contactOk ? "" : "Add the bookings contact's email and phone");

  // Hosted: the listing itself (the property fills it in, or Avante from its files).
  if (path === "hosted") {
    const todo = (c.readyTodo || []).filter((t) => !/^Coordinates|^Placed in the hub|^Rates set/.test(t));
    const noCheckIn = !has(l.checkInTime);
    if (!todo.length && !noCheckIn) set("listing", "done");
    else if (l.helpRequest || l.fillChoice === "avante" || l.hostedSetup !== "completing") set("listing", "you", (todo.concat(noCheckIn ? ["Check-in time"] : [])).join(", "));
    else set("listing", "owner", "The owner is filling it in: " + todo.slice(0, 3).join(", ") + (todo.length > 3 ? "…" : ""));
  }

  // Location: the pin checked with Google and placed in the hub tree.
  const pinned = l.coordsVerified === "Y" && (has(l.treePlace) || has(l.suburb));
  const diffs = locationDiffs(l, row);
  if (!pinned) set("location", "you", "Check the pin with Google so the hub can place it");
  else if (diffs.length && !l.locationSentAt) set("location", "you", "Stock Network's " + diffs.map((d) => d.label).join(", ") + " differ from the hub's");
  else set("location", "done");

  // Hosted: rates on the calendar.
  if (path === "hosted") {
    const n = (l.rateSeasons || []).length;
    set("rates", n ? "done" : (l.hostedSetup === "completing" && !l.helpRequest && l.fillChoice !== "avante" ? "owner" : "you"), n ? "" : "No rates yet");
  }

  // Channel: the Site Nr and Stock Network's set-up sheet.
  if (path === "channel") {
    if (!e && !has(l.siteNr)) set("siteNr", "you", "No Site Nr yet");
    else if (e && Array.isArray(e.sendLog) && e.sendLog.length && !e.sendLog[e.sendLog.length - 1].ok) set("siteNr", "you", "The set-up sheet didn't send");
    else if (e && (e.status === "Spare" || e.status === "Ready to send")) set("siteNr", "you", "Send the set-up sheet");
    else set("siteNr", "done");
    // Check the site Stock Network made.
    if (has(l.siteVerifiedAt)) set("verify", "done");
    else if (has(l.resortId) || (e && e.status === "Set up")) set("verify", "you", "Check it's the right site");
    else set("verify", "wait", "Stock Network hasn't set it up yet (the hub checks every hour)");
  }

  // Hosted: Stock Network has the files, set the site up and has stock.
  if (path === "hosted") {
    if (!has(l.siteNr)) set("sn", "later", "Gets a Site Nr once the listing is complete");
    else if (!l.snSentAt && !(e && ["Sent", "Set up"].includes(e.status))) set("sn", "you", "Send the property and rates files");
    else if (!has(l.resortId) && !(e && e.status === "Set up")) set("sn", "wait", "Stock Network is setting the site up");
    else if (e && e.goLive && /waiting/i.test(String(e.goLive))) set("sn", "wait", "Waiting for Stock Network to load the rates");
    else set("sn", "done");
  }

  // Connect: the property's Avante login pasted, so the hub works for it.
  const setUp = has(l.resortId) || (e && e.status === "Set up");
  if (pa && pa.connected) set("connect", "done");
  else if (!setUp) set("connect", "later", "Once Stock Network has set it up");
  else set("connect", "you", "Paste the Avante login from Stock Network");

  // Reviews: rating link from the review app, and a star rating.
  const stars = has(l.selfSupplierRating) && /\d/.test(String(l.selfSupplierRating)) && !/\./.test(String(l.selfSupplierRating));
  if (has(l.ratingLink) && stars && l.ratingGoogle !== "needs_confirm") set("reviews", "done");
  else if (!has(l.resortId)) set("reviews", "later", "Once Stock Network has set it up");
  else set("reviews", "you", [!has(l.ratingLink) ? "Get the rating link" : "", l.ratingGoogle === "needs_confirm" ? "Confirm the Google match" : "", !stars ? "Pick the star rating" : ""].filter(Boolean).join(", "));

  // Hosted: the other channels linked by iCal, and their bookings on Avante.
  if (path === "hosted") {
    const listed = listedChannels(l);
    const links = (pa && pa.channelLinks) || {};
    const missing = listed.filter((ch) => !links[ch]);
    const pending = (pa && pa.pendingChannelBookings) || 0;
    if (!listed.length && !Object.keys(links).length) set("channels", "done", "No other channels");
    else if (!pa || !pa.connected) set("channels", "later", "Once it is connected");
    else if (missing.length) set("channels", l.channelInvites || (pa && pa.channelHelp) ? "you" : "owner",
      (l.channelInvites || (pa && pa.channelHelp) ? "Link " : "The owner invites Avante on ") + missing.join(", "));
    else if (pending) set("channels", "you", pending + " channel booking" + (pending === 1 ? "" : "s") + " not on Avante yet");
    else set("channels", "done");
  }

  // The owner's part: a password, and (hosted) how they take bookings and get paid.
  if (!pa || !pa.connected) set("owner", "later", "Once it is connected");
  else {
    const left = [];
    if (!c.hasPassword) left.push("choose a password");
    if (path === "hosted") {
      const s = (pa && pa.settings) || {};
      if (!s.setupBookings) left.push("save how they take bookings and how guests pay (Channels)");
    }
    set("owner", left.length ? "owner" : "done", left.length ? "To do: " + left.join(", ") : "");
  }

  // Go live: everything before it done, then admin taps Go live.
  const steps = PATHS[path];
  const before = steps.filter((id) => id !== "golive");
  if (has(l.liveAt)) set("golive", "done");
  else if (before.every((id) => status[id] === "done")) set("golive", "you", "Everything is ready: tap Go live");
  else set("golive", "later", "Once the steps above are done");

  const list = steps.map((id, i) => ({ id, n: i + 1, title: STEP_TITLES[id], status: status[id], note: note[id] }));
  const WHO = { you: "Your turn", owner: "Owner's turn", wait: "Waiting on Stock Network" };
  const outstanding = list.filter((s) => s.status === "you" || s.status === "owner" || s.status === "wait")
    .map((s) => ({ id: s.id, n: s.n, title: s.title, what: s.note || s.title, who: WHO[s.status], status: s.status }));
  return { path, steps: list, outstanding, done: list.filter((s) => s.status === "done").length, total: list.length, locationDiffs: diffs };
}
