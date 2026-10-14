// Email address lists (Jean, 2026-10-14): every email field in the hub may
// hold several addresses separated by commas (or semicolons / spaces), e.g.
// "owner@x.co.za, bookings@x.co.za, jeanl1967+aff123@gmail.com" — the last
// kind sets off other actions such as the WhatsApp group messages. Every
// place that saves, checks or sends to one of these fields uses this file, so
// they all read a list the same way.
// Guest and applicant emails stay one address (one person).

const ONE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// "a@x.com, b@y.com" -> ["a@x.com", "b@y.com"] (valid, unique, at most `max`).
export function emailList(v, max = 10) {
  const out = [];
  for (const p of String(v == null ? "" : v).split(/[,;\s]+/)) {
    const e = p.trim();
    if (e && ONE.test(e) && !out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

// The parts that aren't valid addresses, to tell the person which one is wrong.
export function badEmails(v) {
  return String(v == null ? "" : v).split(/[,;\s]+/).map((p) => p.trim()).filter((p) => p && !ONE.test(p));
}

// The list as it is stored and shown: "a@x.com, b@y.com".
export function emailText(v, max = 10) { return emailList(v, max).join(", "); }

// Several lists merged into one (owner + contact person), no doubles.
export function mergeEmails(...lists) {
  const out = [];
  for (const l of lists) for (const e of emailList(Array.isArray(l) ? l.join(",") : l, 20)) if (!out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e);
  return out;
}

// Who gets the hub's emails about a property (Jean, 2026-10-14): the owner,
// the contact person, or both. Falls back to whoever has an address.
//   who: "owner" | "contact" | "both" (default "both")
export function recipients(ownerEmails, contactEmails, who) {
  const o = emailList(ownerEmails, 20), c = emailList(contactEmails, 20);
  if (who === "owner") return o.length ? o : c;
  if (who === "contact") return c.length ? c : o;
  return mergeEmails(o, c);
}
