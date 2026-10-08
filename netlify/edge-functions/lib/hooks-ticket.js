// Hook builder sign-in (Jean, 2026-10-08).
//
// The hook builder (avante-hooks.netlify.app) lets in only people the hub
// sends there: a signed-in affiliate whose hook builder access admin has
// switched on, or admin. When they click "Open the hook builder", the hub
// makes a ticket — who they are, signed with HOOKS_SSO_SECRET (set on both
// sites), valid for 5 minutes — and the hook builder swaps it for its own
// login. Nothing secret is in the ticket; the signature is what's trusted.
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const HOOKS_URL = "https://avante-hooks.netlify.app/";

export async function makeHooksTicket(who) {
  const secret = Deno.env.get("HOOKS_SSO_SECRET") || "";
  if (!secret) throw new Error("The hook builder sign-in isn't set up yet (HOOKS_SSO_SECRET is missing).");
  const payload = {
    sub: String(who.sub || ""),
    name: String(who.name || "").slice(0, 80),
    role: who.role === "admin" ? "admin" : "affiliate",
    exp: Date.now() + 5 * 60 * 1000,
    n: b64url(crypto.getRandomValues(new Uint8Array(9))),
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return body + "." + sig;
}

export async function hooksLink(who) {
  return HOOKS_URL + "#ticket=" + (await makeHooksTicket(who));
}
