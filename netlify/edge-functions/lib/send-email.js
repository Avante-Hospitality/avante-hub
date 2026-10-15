// One way to send the hub's emails (Resend), so every sender handles the
// key, the From address and the answer the same way.
//   sendEmail({ to, subject, html, attachments?, replyTo? })
//     to: "a@x, b@y" or an array; attachments: [{ filename, content (base64) }]
//   -> { ok, id?, error? }  (never throws)
import { emailList } from "./emails.js";

export const FROM = "Avante Travel <bookings@go.avantetravel.co.za>";
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : Deno.env.get(k)) || "";

export async function sendEmail({ to, subject, html, attachments, replyTo }, fetchImpl = fetch) {
  const list = emailList(Array.isArray(to) ? to.join(",") : to, 20);
  if (!list.length) return { ok: false, error: "No email address to send to." };
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { ok: false, error: "Email isn't switched on (RESEND_API_KEY missing)." };
  const msg = { from: FROM, to: list, subject, html };
  if (attachments && attachments.length) msg.attachments = attachments;
  const reply = emailList(replyTo);
  if (reply.length) msg.reply_to = reply;
  try {
    const r = await fetchImpl("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: JSON.stringify(msg),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (d && (d.message || d.error)) || "The email service said " + r.status + "." };
    return { ok: true, id: (d && d.id) || "" };
  } catch (e) {
    return { ok: false, error: "Could not reach the email service: " + String((e && e.message) || e) };
  }
}
