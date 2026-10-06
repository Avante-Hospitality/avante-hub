// Encryption for stored Stock Network credentials (AES-GCM, 256-bit key from
// the PA_ENC_KEY environment variable, base64) and random tokens.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf) { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); }
function unb64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }

async function key(rawB64) {
  if (!rawB64) throw new Error("PA_ENC_KEY is not set");
  const raw = unb64(rawB64);
  if (raw.length !== 32) throw new Error("PA_ENC_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJSON(obj, rawKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(rawKey), enc.encode(JSON.stringify(obj)));
  return b64(iv) + "." + b64(ct);
}

export async function decryptJSON(str, rawKey) {
  const [iv, ct] = String(str || "").split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(rawKey), unb64(ct));
  return JSON.parse(dec.decode(pt));
}

export function randomToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
