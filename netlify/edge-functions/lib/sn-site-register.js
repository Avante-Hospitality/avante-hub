// Stock Network Site Nr register and the "Request_pull_area" set-up sheet
// (Jean, 2026-10-15).
//
// Every property is set up on Stock Network first — also one that wants to be
// a property affiliate. Avante hands out the Site Nr, so the hub keeps the one
// list of numbers given out and takes the next free one ("Spare" until Stock
// Network has set the site up). The first number the hub gives is 6023 (6021
// and 6022 went out on Jean's sheet of 15 Oct before the hub kept the list).
//
// The sheet has Stock Network's own Request_pull_area columns in their order
// (Jean's Upload_15.10.26.xlsx), without City2: SN keeps City2 as it is.
// Rate is 17.25 when a property is first created on Stock Network; a channel
// property affiliate's 4.95% sits in a different SN field, set later.
//
// Plain ESM with the store and SheetJS passed in, so it runs in the edge
// function and in tests. The store must come from @netlify/blobs v10 or later:
// only those honour { onlyIfNew } (v8 ignores it), which is what stops two
// requests taking the same number.

export const SITE_REGISTER_STORE = "sn-site-register";
export const FIRST_SITE_NR = 6023;
export const SN_SETUP_RATE = 17.25;
export const DEFAULT_SN_SETUP_EMAILS = "nb@stocknetwork.co.za, admin@avantehospitality.co.za, liason@avantehospitality.co.za";
export const REQUEST_COLS = ["SiteID", "BBID", "Name", "Contact", "Phone No", "Email", "Description", "Area", "District", "Rate", "TripAdvisor Search Link", "Suburb"];
// Spare: reserved, sheet not sent yet or not answered. Ready to send: a
// property not on a channel manager finished its listing and got its Site Nr
// then (Jean, 2026-10-19); admin sends its files to Stock Network from the
// listing. Sent: emailed to Stock Network. Set up: Stock Network has created
// the site. ("Waiting for listing" only on entries made 17-19 Oct 2026.)
export const SITE_STATUSES = ["Spare", "Ready to send", "Sent", "Set up"];
export const READY_TO_SEND = "Ready to send";

const KEY_PREFIX = "nr:";
const keyOf = (nr) => KEY_PREFIX + nr;
const MAX_TRIES = 25;

// One line of text (no line breaks: it goes into email subjects and sheet cells).
function text(v, max) { return String(v == null ? "" : v).normalize("NFC").replace(/[\r\n\t]+/g, " ").trim().slice(0, max || 300); }
function lines(v, max) { return String(v == null ? "" : v).normalize("NFC").trim().slice(0, max || 1000); }

export function validSiteNr(v) {
  const n = Number(String(v == null ? "" : v).trim());
  return Number.isInteger(n) && n > 0 && n < 10000000 ? n : 0;
}

// Every entry, highest Site Nr first.
export async function listSiteNrs(store) {
  const { blobs } = await store.list({ prefix: KEY_PREFIX });
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)));
  return all.filter(Boolean).sort((a, b) => b.siteNr - a.siteNr);
}

export async function nextFreeSiteNr(store) {
  const { blobs } = await store.list({ prefix: KEY_PREFIX });
  const used = blobs.map((b) => validSiteNr(b.key.slice(KEY_PREFIX.length))).filter(Boolean);
  return Math.max(FIRST_SITE_NR - 1, ...used) + 1;
}

// Writes the entry only if that Site Nr has never been given out. Two
// requests at the same moment can't both get one number: the store refuses
// the second write and the loop below moves on to the next number.
async function claim(store, nr, entry) {
  const res = await store.setJSON(keyOf(nr), Object.assign({}, entry, { siteNr: nr }), { onlyIfNew: true });
  return !(res && res.modified === false);
}

// The next free Site Nr, reserved for `entry`. Returns the number.
export async function reserveNextSiteNr(store, entry) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const nr = await nextFreeSiteNr(store);
    if (await claim(store, nr, entry)) return nr;
  }
  throw new Error("Could not reserve a Site Nr: too many at the same moment. Try again.");
}

// A number Avante gives out by hand (e.g. one SN already used). Fails if it's taken.
// A number far above the next free one is almost always a typo, and would move
// every later number up for good.
export const MAX_JUMP = 100;
export async function reserveSiteNr(store, nr, entry) {
  const n = validSiteNr(nr);
  if (!n) throw new Error("Type a Site Nr (a whole number).");
  const next = await nextFreeSiteNr(store);
  if (n > next + MAX_JUMP) throw new Error("Site Nr " + n + " is far above the next free one (" + next + "). Check the number: every later number would start after it.");
  if (!(await claim(store, n, entry))) throw new Error("Site Nr " + n + " is already in the list.");
  return n;
}

// An earlier request for the same property that Stock Network hasn't set up
// yet (same BBID, or same name and email): a second submit reuses its Site Nr
// instead of taking a new one and emailing Stock Network again.
export async function findOpenRequest(store, f) {
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9@.]+/g, "");
  const bbid = norm(f.bbid).replace(/^0+/, ""), name = norm(f.propertyName), email = norm(f.email);
  return (await listSiteNrs(store)).find((e) => e.status !== "Set up" &&
    ((bbid && norm(e.bbid).replace(/^0+/, "") === bbid) || (name && email && norm(e.propertyName) === name && norm(e.email) === email))) || null;
}

export async function getSiteNr(store, nr) {
  const n = validSiteNr(nr);
  return n ? store.get(keyOf(n), { type: "json" }) : null;
}

export async function saveSiteNr(store, entry) {
  await store.setJSON(keyOf(entry.siteNr), entry);
  return entry;
}

// A new entry from what the property typed on "List your property".
export function newEntry(f) {
  const now = new Date().toISOString();
  return {
    status: "Spare", createdAt: now, updatedAt: now,
    propertyName: text(f.propertyName, 200), bbid: text(f.bbid, 40), channelManager: text(f.channelManager, 40), eresRef: text(f.eresRef, 60),
    contactName: text(f.contactName, 120), phone: text(f.phone, 200), email: text(f.email, 600),
    description: lines(f.description || f.propertyName, 1000),
    area: text(f.area, 120), district: text(f.district, 120), suburb: text(f.suburb, 120),
    propertyAffiliate: !!f.propertyAffiliate, listingId: text(f.listingId, 20), note: lines(f.note, 500),
    sendLog: [],
  };
}

// The sheet row, in REQUEST_COLS order.
export function requestRow(e) {
  // BBID as a number like SN's sheet, unless that would drop a leading zero.
  return [e.siteNr, e.bbid ? (/^[1-9]\d{0,14}$/.test(e.bbid) ? Number(e.bbid) : e.bbid) : "", e.propertyName, e.contactName, e.phone, e.email,
    e.description || e.propertyName, e.area, e.district, SN_SETUP_RATE, "", e.suburb];
}

// "Upload_15.10.26_site6023_Kloof_Lane.xlsx" (dd.mm.yy, like Jean's sheets).
export function sheetFileName(e, when = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const d = p(when.getUTCDate()) + "." + p(when.getUTCMonth() + 1) + "." + String(when.getUTCFullYear()).slice(2);
  const name = String(e.propertyName || "property").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "property";
  return "Upload_" + d + "_site" + e.siteNr + "_" + name + ".xlsx";
}

// The sheet as base64 (for an email attachment). Phone No is text, as in SN's sheet.
export function requestSheetBase64(XLSX, entries) {
  const ws = XLSX.utils.aoa_to_sheet([REQUEST_COLS].concat(entries.map(requestRow)));
  for (let r = 1; r <= entries.length; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: 4 });
    if (ws[ref]) { ws[ref].t = "s"; ws[ref].z = "@"; }
  }
  ws["!cols"] = REQUEST_COLS.map((h) => ({ wch: Math.max(10, Math.min(40, h.length + 4)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Request_pull_area");
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The email to Stock Network (and Avante) that goes with the sheet.
export function setupEmail(e) {
  const subject = "New property for Stock Network: " + e.propertyName + " (Site Nr " + e.siteNr + (e.bbid ? ", BBID " + e.bbid : "") + ")";
  const system = e.channelManager === "NightsBridge" ? "NightsBridge (BBID " + esc(e.bbid) + ")"
    : e.channelManager === "eRes/NebulaCRS" ? "eRes/NebulaCRS" + (e.eresRef ? " (ref " + esc(e.eresRef) + ")" : "")
    : "Not on a channel manager yet";
  const html = "<p>Hello,</p>" +
    "<p>Please set up <b>" + esc(e.propertyName) + "</b> on Stock Network on <b>Site Nr " + esc(e.siteNr) + "</b>" +
    (e.channelManager === "NightsBridge" ? " and import it from NightsBridge (BBID " + esc(e.bbid) + ")" : "") + ". The sheet is attached.</p>" +
    "<p><b>System:</b> " + system + "<br><b>Contact:</b> " + esc(e.contactName) + " · " + esc(e.phone) + " · " + esc(e.email) + "</p>" +
    (e.propertyAffiliate
      ? "<p><b>Property affiliate: yes.</b> Once the site is up, please set the channel property commission field to <b>4.95%</b>. The rate on the sheet is the standard " + SN_SETUP_RATE + ".</p>"
      : "<p>Property affiliate: no. Rate on the sheet: " + SN_SETUP_RATE + ".</p>") +
    (e.note ? "<p>" + esc(e.note).replace(/\n/g, "<br>") + "</p>" : "") +
    "<p>Avante Travel</p>";
  return { subject, html };
}

// The confirmation to the property.
export function confirmationEmail(e) {
  return {
    subject: "We've received your listing: " + e.propertyName,
    html: "<p>Hello " + esc(e.contactName || "") + ",</p>" +
      "<p>Thank you. We've sent <b>" + esc(e.propertyName) + "</b>'s details to Avante's booking system to set it up. Your Avante Site Nr is <b>" + esc(e.siteNr) + "</b>.</p>" +
      (e.propertyAffiliate ? "<p>You also asked to become an Avante Property Affiliate. Once Avante has set you up, we'll email you a link to complete your listing.</p>" : "") +
      "<p>Questions? Reply to this email or write to info@avantehospitality.co.za.</p><p>Avante Hospitality</p>",
  };
}

// To the property when Avante has set it up (Jean, 2026-10-17): its hub login.
// The hub never emails a password: the property sets its own with
// "Forgot your password?" on the login page. Properties never see Stock Network.
export function welcomeEmail(e, affId, loginUrl) {
  const channel = e.channelManager && e.channelManager !== "None yet";
  return {
    subject: "You're set up with Avante: " + e.propertyName,
    html: "<p>Hello " + esc(e.contactName || "") + ",</p>" +
      "<p><b>" + esc(e.propertyName) + "</b> is now set up with Avante (Avante Site Nr <b>" + esc(e.siteNr) + "</b>).</p>" +
      (channel
        ? "<p>Avante is now one of your channels. Your rates and availability keep coming from your channel manager; nothing changes there.</p>" +
          "<p>Whenever you like, you can also use Avante's hub to promote your property with the hook builder, add activities to your promotions and earn extra income from them.</p>"
        : "<p>You can now use Avante's hub for your calendar, bookings, guests, your own booking page and promotions.</p>") +
      "<p><b>Your hub login</b><br>Affiliate number: <b>" + esc(affId) + "</b><br>" +
      "Open <a href=\"" + esc(loginUrl) + "\">" + esc(loginUrl) + "</a> and tap <b>Forgot your password?</b> to choose your password.</p>" +
      "<p>When you're ready to connect, Avante will send you your Avante login (username, client ID and client secret).</p>" +
      "<p>Questions? Reply to this email or write to info@avantehospitality.co.za.</p><p>Avante Hospitality</p>",
  };
}

// The welcome email of "Activate a channel property" (Jean, 2026-10-18):
// admin edits it in Property Listings, and can change it for one property in
// step 5. Plain text: a blank line starts a new paragraph, **words** are bold.
// Fill-in words: {property} {contact} {siteNr} {affiliateNumber} {loginLink}.
export const CHANNEL_WELCOME_DEFAULT = {
  subject: "You're set up with Avante: {property}",
  body: [
    "Hello {contact},",
    "{property} is now set up with Avante (Avante Site Nr {siteNr}).",
    "Avante is now one of your channels. Your rates and availability keep coming from your channel manager; nothing changes there.",
    "Whenever you like, you can also use Avante's hub to promote your property with the hook builder, add activities to your promotions and earn extra income from them.",
    "**Your hub login**\nAffiliate number: {affiliateNumber}\nOpen {loginLink} and tap **Forgot your password?** to choose your password.",
    "Your property is already connected: log in, open **Property Affiliate**, and the **Hook Builder** and **Activities** are ready to use.",
    "Questions? Reply to this email or write to info@avantehospitality.co.za.\nAvante Hospitality",
  ].join("\n\n"),
};
// The same pop-up for a property not on a channel manager (Jean, 2026-10-19):
// a Property Affiliate with its own calendar, rates and booking page.
export const PROPERTY_WELCOME_DEFAULT = {
  subject: CHANNEL_WELCOME_DEFAULT.subject,
  body: [
    "Hello {contact},",
    "{property} is now set up with Avante (Avante Site Nr {siteNr}).",
    "You can now use Avante's hub for your calendar, bookings, guests, your own booking page and promotions with the hook builder.",
    "**Your hub login**\nAffiliate number: {affiliateNumber}\nOpen {loginLink} and tap **Forgot your password?** to choose your password.",
    "Your property is already connected: log in and open **Property Affiliate**.",
    "Questions? Reply to this email or write to info@avantehospitality.co.za.\nAvante Hospitality",
  ].join("\n\n"),
};
const FILL = /\{(property|contact|siteNr|affiliateNumber|loginLink)\}/g;
// Plain text with the fill-in words filled (for the subject and the editor).
export function fillWelcome(text, v) {
  return String(text || "").replace(FILL, (m, k) => (k === "loginLink" ? v.loginLink : String(v[k] || ""))).replace(/ +,/g, ",");
}
// The email's HTML: escaped text, paragraphs, **bold**, and the login link clickable.
export function welcomeHtml(text, v) {
  const link = String(v.loginLink || "");
  return String(text || "").replace(/\r/g, "").split(/\n{2,}/).map((para) => {
    // The login link is clickable whether the text has {loginLink} or the link itself (step 5 shows it filled in).
    const p0 = link ? para.trim().split(link).join("{loginLink}") : para.trim();
    let h = esc(fillWelcome(p0, Object.assign({}, v, { loginLink: "\u0000LINK\u0000" })));
    h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>").split("\u0000LINK\u0000").join('<a href="' + esc(link) + '">' + esc(link) + "</a>");
    return h ? "<p>" + h + "</p>" : "";
  }).join("");
}
