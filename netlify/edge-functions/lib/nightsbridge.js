// A NightsBridge property's public details, by its BBID (Jean, 2026-10-25).
// The List your property page checks a BBID here before Stock Network knows
// the property: NightsBridge's own booking page (book.nightsbridge.com/<BBID>)
// reads the same public call. Only what the hub uses is returned.

const NB_API = "https://www.nightsbridge.com/bridge/api/5.0/establishment/";
const TIMEOUT_MS = 8000;

// BBIDs are numbers. Leading zeros are dropped, as NightsBridge does.
export function cleanBbid(v) {
  const s = String(v == null ? "" : v).trim().replace(/^0+/, "");
  return /^\d{1,9}$/.test(s) ? s : "";
}

// The grading NightsBridge shows: the tourism board's when graded, else the
// property's own (self assessment). -> { stars: "3 Star" | "", source }
export function gradingOf(list) {
  const rows = Array.isArray(list) ? list : [];
  const stars = (r) => (/(\d)\s*star/i.exec(String((r && r.grade) || "")) || [])[1];
  const board = rows.find((r) => /tourism grading/i.test(String(r && r.gradingauthority)) && stars(r));
  if (board) return { stars: stars(board) + " Star", source: "Tourism Grading Council" };
  const self = rows.find((r) => /self/i.test(String(r && r.gradingauthority)) && stars(r));
  if (self) return { stars: stars(self) + " Star", source: "Self assessment" };
  return { stars: "", source: "" };
}

// -> { ok: true, property } | { ok: false, notFound?, error }
export async function nightsbridgeProperty(bbid, fetchImpl = fetch) {
  const id = cleanBbid(bbid);
  if (!id) return { ok: false, error: "A NightsBridge number (BBID) is only digits, e.g. 26762." };
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res, d;
  try {
    res = await fetchImpl(NB_API + id, { headers: { accept: "application/json", origin: "https://book.nightsbridge.com", referer: "https://book.nightsbridge.com/" + id }, signal: ctl.signal });
    d = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, error: "NightsBridge didn't answer. Try again in a minute." };
  } finally { clearTimeout(timer); }
  const c = d && d.data && d.data.contentrs;
  if (!res.ok || !c || !c.name) return { ok: false, notFound: true, error: "NightsBridge has no property with number " + id + ". Check the number." };
  const str = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const lat = Number(c.lat), lng = Number(c.lng);
  const g = gradingOf(c.grading);
  return { ok: true, property: {
    bbid: id, name: str(c.name, 200), active: c.active !== false,
    contact: str(c.contacts, 120), phone: str(c.phoneno, 40), cell: str(c.cellno, 40), email: str(c.email, 200), website: str(c.website, 200),
    address: String(c.address || "").split(/\n+/).map((x) => x.trim()).filter(Boolean).join(", ").slice(0, 300), suburb: str(c.suburb, 120),
    lat: isFinite(lat) && lat !== 0 ? lat : null, lng: isFinite(lng) && lng !== 0 ? lng : null,
    type: str(c.propertytypedescription, 60), checkIn: str(c.checkintime, 10), checkOut: str(c.checkouttime, 10),
    stars: g.stars, starsSource: g.source,
    rooms: (Array.isArray(c.roomtypes) ? c.roomtypes : []).slice(0, 40).map((r) => ({ name: str(r.roomtypename, 120), sleeps: Number(r.maxoccupancy) || 0, count: Number(r.roomcount) || 0 })),
    bookingPage: "https://book.nightsbridge.com/" + id,
  } };
}
