// Minimal iCalendar (RFC 5545) reading and writing for availability sync.
// Channels (Airbnb, Booking.com, LekkeSlaap) publish all-day VEVENTs whose
// DTEND is the check-out day (exclusive). We only need dates, UID and SUMMARY.

function unfold(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function toIso(v) {
  // 20261204 | 20261204T140000Z | 20261204T140000
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v || "").trim());
  return m ? m[1] + "-" + m[2] + "-" + m[3] : null;
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text).split("\n")) {
    const line = raw.trimEnd();
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start) {
        if (!cur.end || cur.end <= cur.start) {
          const d = new Date(cur.start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); cur.end = d.toISOString().slice(0, 10);
        }
        if (!cur.uid) cur.uid = cur.start + "_" + cur.end;
        events.push(cur);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (name === "DTSTART") cur.start = toIso(value);
    else if (name === "DTEND") cur.end = toIso(value);
    else if (name === "UID") cur.uid = value.trim();
    else if (name === "SUMMARY") cur.summary = value.replace(/\\,/g, ",").replace(/\\n/gi, " ").trim();
    else if (name === "DESCRIPTION") cur.description = value.replace(/\\,/g, ",").replace(/\\n/gi, " ").trim().slice(0, 300);
  }
  return events;
}

function esc(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }
function compact(iso) { return iso.replace(/-/g, ""); }

// ranges: [{ start, end, uid, summary }]
export function buildIcs(calName, ranges) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Avante Travel Hub//Property Affiliate//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:" + esc(calName)];
  for (const r of ranges) {
    lines.push("BEGIN:VEVENT", "UID:" + esc(r.uid), "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + compact(r.start), "DTEND;VALUE=DATE:" + compact(r.end), "SUMMARY:" + esc(r.summary || "Not available"), "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// Turn a set of ISO nights into consecutive ranges.
export function nightsToRanges(nights) {
  const sorted = [...new Set(nights)].sort();
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === n) {
      const d = new Date(n + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); last.end = d.toISOString().slice(0, 10);
    } else {
      const d = new Date(n + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
      out.push({ start: n, end: d.toISOString().slice(0, 10) });
    }
  }
  return out;
}
