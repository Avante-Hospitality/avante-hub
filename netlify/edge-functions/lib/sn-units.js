// Unit types per property, read from Stock Network's public resort pages
// (ResortInfo.aspx → "Unit Types Available"). Jean, 2026-10-14: the location
// tree goes one level deeper than the property — each kind of unit once
// (identical units merged), with its type and how many it sleeps — so the
// hub can search before asking Stock Network for availability.
// A line is [type, sleeps, bedrooms, count, unitNames, photos]. sleeps/bedrooms may be null.
// photos: the units' own Stock Network photos (Jean, 2026-10-17: unit photos are
// tagged per unit type, as in the tree), full addresses, up to 12.

export const STD_TYPES = ["Double Room", "Apartment", "King Room", "Queen Room", "Cottage", "Suite", "Family Room", "Holiday home", "Twin Room", "Chalet", "Tent", "Villa", "Studio", "Triple Room", "Single Room", "Cabin", "Large suite", "Campsite", "Rondawel", "Quadruple Room", "Penthouse", "Loft", "Bungalow", "Dormitory room", "Bed in dormitory", "Mobile home"];
// A property's own words in the Room Type box: the nearest standard type, else "Other".
const KW = [[/penthouse/i, "Penthouse"], [/villa/i, "Villa"], [/chalet/i, "Chalet"], [/cottage/i, "Cottage"], [/cabin/i, "Cabin"], [/rondav/i, "Rondawel"], [/bungalow/i, "Bungalow"], [/\bloft/i, "Loft"], [/stu?i?dio/i, "Studio"], [/suite/i, "Suite"],
  [/apartment|\bflat\b|duplex|simplex/i, "Apartment"], [/house|home/i, "Holiday home"], [/tent|glamping/i, "Tent"], [/camp/i, "Campsite"], [/dorm/i, "Dormitory room"], [/lodge/i, "Chalet"], [/family/i, "Family Room"], [/twin/i, "Twin Room"],
  [/king/i, "King Room"], [/queen/i, "Queen Room"], [/double/i, "Double Room"], [/single/i, "Single Room"], [/hotel room|\broom\b/i, "Double Room"]];

const ent = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
const clean = (s) => ent(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const num = (x) => { if (!/^\s*\d{1,2}\s*$/.test(x || "")) return null; const n = parseInt(x, 10); return n > 0 && n <= 60 ? n : null; };

const SN = "https://old.stocknetwork.co.za";
// The raw units on a resort page: [{ unit, title, roomType, maxGuests, photos }].
// Each unit's box has its own photo carousel just before its name.
export function parseUnits(html) {
  const s = String(html || ""), i = s.indexOf('id="dvUnitTypes"');
  if (i < 0) return [];
  const j = s.indexOf('id="dvModals"', i), k = s.indexOf("&copy;", i), end = j > i ? j : k > i ? k : i + 200000, blk = s.slice(i, end);
  const re = /<h3><b>([\s\S]*?)<\/b><\/h3>\s*<div class='row'>\s*<h5>([\s\S]*?)<\/h5>[\s\S]*?Room Type:<span>([\s\S]*?)<\/span>[\s\S]*?Max Guests:<span>([\s\S]*?)<\/span>/g;
  const out = []; let m, last = 0;
  while ((m = re.exec(blk))) {
    // Photos between the previous unit and this unit's name are this unit's.
    const photos = [];
    for (const im of blk.slice(last, m.index).matchAll(/<img[^>]+src=['"]([^'"]+)['"]/gi)) {
      const src = im[1]; if (!/\/data\/resort\/|\/image\/\d+\/gallery\//i.test(src)) continue;
      const abs = /^https?:/i.test(src) ? src : SN + (src.startsWith("/") ? "" : "/") + src;
      if (!photos.includes(abs)) photos.push(abs);
    }
    last = re.lastIndex;
    out.push({ unit: clean(m[1]), title: clean(m[2]), roomType: clean(m[3]), maxGuests: clean(m[4]), photos });
  }
  return out;
}
function sleepsOf(u) {
  const n = num(u.maxGuests); if (n) return n;
  for (const f of [u.roomType, u.title, u.unit]) {
    const m = /(\d{1,2})\s*-?\s*sleeper/i.exec(f || "") || /sleeps\s*(?:up to\s*|maximum\s*)?(\d{1,2})/i.exec(f || "");
    if (m) return parseInt(m[1], 10);
  }
  return num(u.roomType);
}
function bedsOf(u) {
  for (const f of [u.roomType, u.title, u.unit]) {
    const m = /(\d{1,2})\s*-?\s*(?:bed\s?rooms?|bedrrom|bed\b|br\b)/i.exec(f || "");
    if (m) return parseInt(m[1], 10);
    if (/stu?i?dio/i.test(f || "")) return 0;
  }
  return null;
}
function typeOf(u) {
  const rt = (u.roomType || "").trim();
  if (STD_TYPES.includes(rt)) return { type: rt, std: true };
  for (const f of [rt, u.unit, u.title]) for (const [re, t] of KW) if (re.test(f || "")) return { type: t, std: false };
  return { type: "Other", std: false };
}
// Raw units → merged lines, plus the units that need tidying on Stock Network.
export function unitLines(units) {
  const groups = new Map(), messy = [];
  for (const u of units || []) {
    const { type, std } = typeOf(u), s = sleepsOf(u), b = bedsOf(u), k = type + "|" + s + "|" + b;
    const g = groups.get(k) || { type, s, b, n: 0, names: [], photos: [] };
    g.n++; if (u.unit && !g.names.includes(u.unit) && g.names.length < 8) g.names.push(u.unit.slice(0, 60));
    for (const ph of u.photos || []) if (!g.photos.includes(ph) && g.photos.length < 12) g.photos.push(ph);
    groups.set(k, g);
    const issues = [];
    if (!std) issues.push(u.roomType ? "own text in Room Type" : "no Room Type");
    if (!num(u.maxGuests)) issues.push("no Max Guests");
    if (issues.length) messy.push([u.unit, u.roomType, u.maxGuests, issues.join("; ")]);
  }
  return { lines: [...groups.values()].map((g) => [g.type, g.s, g.b, g.n, g.names, g.photos]), messy };
}
