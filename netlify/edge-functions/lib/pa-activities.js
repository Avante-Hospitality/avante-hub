// Property Affiliate — Activities (2026-10-12, Jean).
// A property keeps its own list of activities it sells to guests, with the
// supplier's reference numbers, so an activity can be booked from the hub:
//   act:{siteId}    = [activity]          the property's activity list
//   actbk:{siteId}  = [activity booking]  bookings made for guests
// An activity can be copied from the hub's Map & Activities list (nearby ones)
// and then completed with the supplier's codes. Booking requests are emailed to
// the supplier until a booking system's API is connected (bookingSystem field).
import { PAError } from "./pa-core.js";
import { nearestByDistance } from "./geo-distance.js";
import { randomToken } from "./pa-crypto.js";

// Booking systems the hub knows. "direct" = phone / email / website.
// Activitar (operators on <operator>.activitar.com) and ActivityBridge (by
// NightsBridge, secure.activitybridge.com) have no public reseller API (checked
// 2026-10-12): bookings go through the operator's booking page with the
// property's agent login, or by email. Their codes are read from the link.
export const ACTIVITY_SYSTEMS = { direct: "Direct with the supplier", activitar: "Activitar", activitybridge: "ActivityBridge", other: "Other booking system" };

// Recognise the booking system from an operator's booking link:
//   https://oceansafaris.activitar.com/services/575          → Activitar, operator "oceansafaris", product 575
//   https://secure.activitybridge.com/book?activityid=12564  → ActivityBridge, product 12564
//   https://secure.activitybridge.com/search?supplierid=88   → ActivityBridge, supplier 88
export function detectSystem(link) {
  let u; try { u = new URL(String(link || "")); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  const m = /^([a-z0-9-]+)\.activitar\.com$/.exec(host);
  if (m && !["www", "new", "network", "status"].includes(m[1])) {
    const sv = /\/services\/(\d+)/.exec(u.pathname);
    return { bookingSystem: "activitar", supplierRef: m[1], productCode: sv ? sv[1] : "" };
  }
  if (host === "secure.activitybridge.com") {
    return { bookingSystem: "activitybridge", supplierRef: u.searchParams.get("supplierid") || "", productCode: u.searchParams.get("activityid") || "" };
  }
  return null;
}

// The operator's booking page for one booking (date and people filled in where the system allows).
export function bookingPageLink(a, b = {}) {
  if (a.bookingSystem === "activitar" && a.supplierRef && a.productCode) {
    const q = new URLSearchParams();
    if (b.adults != null) q.set("adults", String(b.adults));
    if (b.children != null) q.set("children", String(b.children));
    if (b.date) q.set("date", b.date);
    return "https://" + encodeURIComponent(a.supplierRef) + ".activitar.com/services/" + encodeURIComponent(a.productCode) + (q.toString() ? "?" + q : "");
  }
  if (a.bookingSystem === "activitybridge" && a.productCode) return "https://secure.activitybridge.com/book?activityid=" + encodeURIComponent(a.productCode);
  if (a.bookingSystem === "activitybridge" && a.supplierRef) return "https://secure.activitybridge.com/search?supplierid=" + encodeURIComponent(a.supplierRef);
  return a.bookingUrl || "";
}
export const ACTIVITY_STATUSES = ["Requested", "Sent to supplier", "Confirmed", "Cancelled"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function str(v, max = 200) { return typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : ""; }
function num(v, min = 0, max = 1e7) { const n = Number(v); return isFinite(n) && v !== "" && v !== null ? Math.max(min, Math.min(max, n)) : null; }
function int(v, min = 0, max = 999) { const n = num(v, min, max); return n == null ? null : Math.round(n); }
function okEmail(e) { return !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function okUrl(u) { if (!u) return true; try { return /^https?:$/.test(new URL(u).protocol); } catch (_) { return false; } }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function newId(prefix) { return prefix + randomToken(6).replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase(); }

// Every field on an activity. The list is also sent to the screen so the
// form and the server stay the same.
export function cleanActivity(body, cur = {}) {
  const a = Object.assign({}, cur);
  const s = (k, n) => { if (body[k] !== undefined) a[k] = str(body[k], n); };
  // What it is
  s("name", 120); s("supplier", 120); s("category", 60); s("description", 1500); s("duration", 40);
  s("startTimes", 120); s("meetingPoint", 200); s("whatToBring", 300); s("notes", 600);
  // Reference numbers needed to book it
  s("bookingSystem", 40); s("systemName", 60); s("supplierRef", 60); s("productCode", 60); s("optionCode", 60);
  // How to book it
  s("bookingPhone", 30); s("bookingEmail", 120); s("bookingUrl", 400);
  s("hubActivityId", 80);
  if (body.days !== undefined) a.days = (Array.isArray(body.days) ? body.days : []).filter((d) => DAYS.includes(d));
  if (body.pickup !== undefined) a.pickup = !!body.pickup;
  if (body.active !== undefined) a.active = !!body.active;
  for (const k of ["adultPrice", "childPrice", "netPrice"]) if (body[k] !== undefined) a[k] = num(body[k], 0, 1e6);
  if (body.commissionPct !== undefined) a.commissionPct = num(body.commissionPct, 0, 100);
  for (const [k, lo, hi] of [["childAge", 0, 17], ["minPax", 1, 500], ["maxPax", 1, 500], ["cutoffHours", 0, 720]]) if (body[k] !== undefined) a[k] = int(body[k], lo, hi);
  if (!a.bookingSystem || !ACTIVITY_SYSTEMS[a.bookingSystem]) a.bookingSystem = "direct";
  // A pasted Activitar / ActivityBridge link fills in the system and its codes.
  const found = detectSystem(a.bookingUrl);
  if (found && (a.bookingSystem === "direct" || a.bookingSystem === found.bookingSystem)) {
    a.bookingSystem = found.bookingSystem;
    if (!a.supplierRef && found.supplierRef) a.supplierRef = found.supplierRef;
    if (!a.productCode && found.productCode) a.productCode = found.productCode;
  }
  if (a.bookingSystem !== "other") a.systemName = "";
  if (a.active === undefined) a.active = true;
  if (!Array.isArray(a.days)) a.days = [];
  if (!a.name) throw new PAError("Give the activity a name.");
  if (!okEmail(a.bookingEmail)) throw new PAError("The supplier's booking email doesn't look right.");
  if (!okUrl(a.bookingUrl)) throw new PAError("The booking link must start with https://");
  if (a.minPax && a.maxPax && a.minPax > a.maxPax) throw new PAError("Minimum people can't be more than maximum people.");
  if (a.bookingSystem === "other" && !a.productCode) throw new PAError("Add the activity's product code in the booking system, so it can be booked there.");
  if (a.bookingSystem === "activitar" && (!a.supplierRef || !a.productCode)) throw new PAError("For Activitar add the operator name (the part before .activitar.com) and the service number, or paste the activity's Activitar booking link.");
  if (a.bookingSystem === "activitybridge" && !a.productCode && !a.supplierRef) throw new PAError("For ActivityBridge add the activity ID or supplier ID, or paste the activity's ActivityBridge booking link.");
  if (a.bookingSystem === "direct" && !a.bookingEmail && !a.bookingPhone && !a.bookingUrl) throw new PAError("Add the supplier's booking email, phone or link, so the activity can be booked.");
  return a;
}

export function createActivities({ store, now = () => new Date(), sendEmail = async () => false, getHubActivities = async () => [], getPin = async () => null }) {
  const getJSON = (k) => store.get(k, { type: "json" });
  const setJSON = (k, v) => store.setJSON(k, v);
  const listOf = async (prop) => (await getJSON("act:" + prop.siteId)) || [];
  const bookingsOf = async (prop) => (await getJSON("actbk:" + prop.siteId)) || [];
  const today = () => now().toISOString().slice(0, 10);

  async function view(prop) {
    const list = await listOf(prop);
    const bookings = (await bookingsOf(prop)).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    return { activities: list.map((a) => Object.assign({}, a, { bookingPage: bookingPageLink(a) })), bookings, systems: ACTIVITY_SYSTEMS, statuses: ACTIVITY_STATUSES, days: DAYS };
  }

  async function save(prop, body) {
    const list = await listOf(prop);
    const id = str(body.id, 20);
    const i = id ? list.findIndex((a) => a.id === id) : -1;
    if (id && i < 0) throw new PAError("That activity no longer exists.", 404);
    const rec = cleanActivity(body, i >= 0 ? list[i] : {});
    if (list.some((a, j) => j !== i && a.name.toLowerCase() === rec.name.toLowerCase() && (a.supplier || "").toLowerCase() === (rec.supplier || "").toLowerCase()))
      throw new PAError("You already have “" + rec.name + "” from this supplier.");
    rec.updatedAt = now().toISOString();
    if (i >= 0) list[i] = rec; else { rec.id = newId("A"); rec.createdAt = rec.updatedAt; list.push(rec); }
    if (list.length > 300) throw new PAError("You can keep up to 300 activities.");
    await setJSON("act:" + prop.siteId, list);
    return Object.assign({ saved: rec }, await view(prop));
  }

  async function remove(prop, id) {
    const list = await listOf(prop);
    const open = (await bookingsOf(prop)).some((b) => b.activityId === id && b.date >= today() && b.status !== "Cancelled");
    if (open) throw new PAError("This activity has upcoming bookings. Cancel them first, or switch the activity off instead.", 409);
    await setJSON("act:" + prop.siteId, list.filter((a) => a.id !== id));
    return view(prop);
  }

  // Hub activities near the property, to copy into the property's list.
  async function nearby(prop, km) {
    const pin = await getPin(prop);
    const lat = pin && parseFloat(pin.latitude), lng = pin && parseFloat(pin.longitude);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return { nearby: [], km: 0, noPin: true };
    const k = Math.max(1, Math.min(150, Number(km) || 50));
    const mine = new Set((await listOf(prop)).map((a) => a.hubActivityId).filter(Boolean));
    const acts = ((await getHubActivities()) || []).filter((a) => a && a.visible !== false);
    const out = nearestByDistance(lat, lng, acts, { limit: 60, maxKm: k }).map((a) => ({
      id: a.id, name: a.name || "", area: a.area || "", price: a.price || "", description: String(a.description || "").slice(0, 300),
      link: a.contactLink || "", distance: a.distanceLabel || "", added: mine.has(a.id), system: (detectSystem(a.contactLink) || {}).bookingSystem || "",
    }));
    return { nearby: out, km: k };
  }

  function priceFor(act, adults, children) {
    if (act.adultPrice == null) return null;
    return Math.round(act.adultPrice * adults + (act.childPrice != null ? act.childPrice : act.adultPrice) * children);
  }

  async function book(prop, body) {
    const act = (await listOf(prop)).find((a) => a.id === str(body.activityId, 20));
    if (!act) throw new PAError("Choose an activity.");
    if (!act.active) throw new PAError("This activity is switched off.");
    const date = str(body.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PAError("Choose the activity date.");
    if (date < today()) throw new PAError("Choose a date from today.");
    const dow = DAYS[(new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7];
    if (act.days.length && !act.days.includes(dow)) throw new PAError(act.name + " doesn't run on a " + dow + ". It runs on " + act.days.join(", ") + ".");
    const adults = int(body.adults, 0, 500) || 0, children = int(body.children, 0, 500) || 0, pax = adults + children;
    if (pax < 1) throw new PAError("Add at least one person.");
    if (act.minPax && pax < act.minPax) throw new PAError(act.name + " needs at least " + act.minPax + " people.");
    if (act.maxPax && pax > act.maxPax) throw new PAError(act.name + " takes at most " + act.maxPax + " people.");
    const time = str(body.time, 10);
    if (act.cutoffHours) {
      const start = Date.parse(date + "T" + (/^\d{2}:\d{2}$/.test(time) ? time : "08:00") + ":00+02:00");
      if (start - now().getTime() < act.cutoffHours * 3600000) throw new PAError(act.name + " must be booked at least " + act.cutoffHours + " hours before it starts.");
    }
    const guestName = str(body.guestName, 120);
    if (!guestName) throw new PAError("Add the guest's name.");
    const guestEmail = str(body.guestEmail, 120);
    if (!okEmail(guestEmail)) throw new PAError("The guest's email doesn't look right.");
    const total = body.total !== undefined && body.total !== "" ? num(body.total, 0, 1e7) : priceFor(act, adults, children);
    const b = {
      ref: newId("ACT-"), activityId: act.id, activity: act.name, supplier: act.supplier || "",
      // A copy of the codes at booking time, so later edits don't change old bookings.
      bookingSystem: act.bookingSystem, systemName: act.systemName || "", supplierRef: act.supplierRef || "", productCode: act.productCode || "", optionCode: act.optionCode || "",
      date, time, adults, children, total, commissionPct: act.commissionPct,
      guestName, guestCell: str(body.guestCell, 30), guestEmail, stayRef: str(body.stayRef, 40),
      pickup: !!body.pickup && !!act.pickup, notes: str(body.notes, 600),
      bookingPage: bookingPageLink(act, { adults, children, date }),
      status: "Requested", supplierConfirmation: "", createdAt: now().toISOString(),
    };
    const list = await bookingsOf(prop);
    list.push(b);
    await setJSON("actbk:" + prop.siteId, list);
    return Object.assign({ booking: b }, await view(prop));
  }

  async function update(prop, ref, change) {
    const list = await bookingsOf(prop);
    const b = list.find((x) => x.ref === str(ref, 30));
    if (!b) throw new PAError("That activity booking wasn't found.", 404);
    change = change || {};
    if (change.status !== undefined) {
      if (!ACTIVITY_STATUSES.includes(change.status)) throw new PAError("Unknown status.");
      if (change.status === "Confirmed" && !str(change.supplierConfirmation ?? b.supplierConfirmation, 60)) throw new PAError("Add the supplier's confirmation number first.");
      b.status = change.status;
    }
    if (change.supplierConfirmation !== undefined) b.supplierConfirmation = str(change.supplierConfirmation, 60);
    if (change.notes !== undefined) b.notes = str(change.notes, 600);
    b.updatedAt = now().toISOString();
    await setJSON("actbk:" + prop.siteId, list);
    return view(prop);
  }

  // Booking request to the supplier by email (reply goes to the property).
  async function sendRequest(prop, ref, replyTo) {
    const list = await bookingsOf(prop);
    const b = list.find((x) => x.ref === str(ref, 30));
    if (!b) throw new PAError("That activity booking wasn't found.", 404);
    const act = (await listOf(prop)).find((a) => a.id === b.activityId) || {};
    if (!act.bookingEmail) throw new PAError("This activity has no supplier booking email. Phone the supplier or use the booking link instead.");
    const rows = [
      ["Activity", b.activity], ["Booking system", ACTIVITY_SYSTEMS[b.bookingSystem] || b.systemName || ""], ["Supplier account / operator", b.supplierRef], ["Product code", b.productCode], ["Option / rate code", b.optionCode],
      ["Date", b.date], ["Time", b.time], ["Adults", b.adults], ["Children", b.children], ["Pick-up from the property", b.pickup ? "Yes" : "No"],
      ["Guest", b.guestName], ["Guest cell", b.guestCell], ["Our reference", b.ref], ["Notes", b.notes],
    ].filter((r) => r[1] !== "" && r[1] != null);
    const html = "<p>Hello " + esc(b.supplier || "") + ",</p><p>Please book the following for our guest and reply with your confirmation number.</p>" +
      "<table cellpadding='6' style='border-collapse:collapse'>" + rows.map((r) => "<tr><td style='border:1px solid #ddd'><b>" + esc(r[0]) + "</b></td><td style='border:1px solid #ddd'>" + esc(r[1]) + "</td></tr>").join("") + "</table>" +
      "<p>Thank you,<br>" + esc(prop.resortName || "") + "</p>";
    const sent = await sendEmail(act.bookingEmail, "Booking request " + b.ref + ": " + b.activity + " on " + b.date, html, { fromName: prop.resortName || "", replyTo: replyTo || undefined });
    if (!sent) throw new PAError("The email couldn't be sent. Try again, or phone the supplier.", 502);
    if (b.status === "Requested") b.status = "Sent to supplier";
    b.sentAt = now().toISOString();
    await setJSON("actbk:" + prop.siteId, list);
    return Object.assign({ sentTo: act.bookingEmail }, await view(prop));
  }

  return { view, save, remove, nearby, book, update, sendRequest, priceFor };
}
