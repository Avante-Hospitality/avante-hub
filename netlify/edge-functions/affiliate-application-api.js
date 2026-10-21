import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { emailList, badEmails } from "./lib/emails.js";
import { isAdminToken } from "./lib/admin-session.js";

// Backs the public "Become an Affiliate" application form (affiliate-application.html)
// and a matching "Applications" review tab in admin.html. Covers both Agent
// and Franchise affiliate types — per the site copy, those two need identical
// fields, just a different intro paragraph on the form itself, so one
// endpoint and one store handle both, with `applicantType` distinguishing them.
//
// This intentionally does NOT collect banking/payment details — those are
// handled by Avante directly after an application is approved, not captured
// on a public-facing form. It also does not auto-create a real affiliate
// record; admin reviews each application here, then adds them as an actual
// affiliate via the existing "+ Add Affiliate" flow once approved.
//
// Property affiliate applications are handled entirely separately, by the
// existing property-onboarding-api.js / property-form.html — nothing here
// touches that flow.

function clean(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max || 500) : "";
}

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nl2br(v) {
  return escapeHtml(v).replace(/\n/g, "<br>");
}

function genApplicationId() {
  const n = Math.floor(Math.random() * 900000) + 100000;
  return "AA-" + n;
}

async function sendNotificationEmail(to, subject, html) {
  try {
    const apiKey = Netlify.env.get("RESEND_API_KEY");
    const list = emailList(to);   // several addresses, comma-separated (Jean, 2026-10-14)
    if (!apiKey || !list.length) return;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: "Avante Travel <bookings@go.avantetravel.co.za>",
        to: list,
        subject: subject,
        html: html,
      }),
    });
  } catch (e) {
    // Email failures should never break the application submit flow.
  }
}

async function getNotificationEmail() {
  const settingsStore = getStore({ name: "affiliate-application-settings", consistency: "strong" });
  const settings = await settingsStore.get("config", { type: "json" });
  return (settings && settings.notificationEmail) || "";
}

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const action = body.action;
  const store = getStore({ name: "affiliate-applications", consistency: "strong" });

  const json = (data, status) =>
    new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "content-type": "application/json", ...cors },
    });

  const requireAdmin = async () => {
    const authed = await isAdminToken(body.token);
    if (!authed) return json({ error: "Not authenticated." }, 401);
    return null;
  };

  try {
    if (action === "submit") {
      const applicantType = body.applicantType === "franchise" ? "franchise" : "agent";
      const id = genApplicationId();
      const now = new Date().toISOString();

      const record = {
        id: id,
        status: "New",
        dateSubmitted: now,
        applicantType: applicantType,
        fullName: clean(body.fullName, 200),
        email: clean(body.email, 200),
        phone: clean(body.phone, 60),
        cityRegion: clean(body.cityRegion, 200),
        promotionPlan: clean(body.promotionPlan, 2000),
        notes: clean(body.notes, 2000),
      };

      if (!record.fullName || !record.email || !record.phone) {
        return json({ error: "Full name, email, and phone are required." }, 400);
      }

      await store.setJSON(id, record);

      const notifyTo = await getNotificationEmail();
      if (notifyTo) {
        const typeLabel = applicantType === "franchise" ? "Franchise Affiliate" : "Agent Affiliate";
        context.waitUntil(
          sendNotificationEmail(
            notifyTo,
            "New " + typeLabel + " application — " + record.fullName,
            "<p>A new affiliate application was submitted.</p>" +
              "<p><strong>Type:</strong> " + escapeHtml(typeLabel) + "<br>" +
              "<strong>Name:</strong> " + escapeHtml(record.fullName) + "<br>" +
              "<strong>Email:</strong> " + escapeHtml(record.email) + "<br>" +
              "<strong>Phone:</strong> " + escapeHtml(record.phone) + "<br>" +
              "<strong>City/Region:</strong> " + escapeHtml(record.cityRegion || "—") + "</p>" +
              "<p><strong>How they plan to promote:</strong><br>" + nl2br(record.promotionPlan || "—") + "</p>" +
              (record.notes ? "<p><strong>Notes:</strong><br>" + nl2br(record.notes) + "</p>" : "") +
              "<p>Log in to Admin &gt; Applications to review.</p>"
          )
        );
      }

      return json({ ok: true, id: id });
    }

    if (action === "list") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const { blobs } = await store.list();
      const records = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
      const applications = records
        .filter(Boolean)
        .sort((a, b) => (b.dateSubmitted || "").localeCompare(a.dateSubmitted || ""));

      return json({ ok: true, applications: applications });
    }

    if (action === "updateStatus") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const id = clean(body.id, 20);
      const status = clean(body.status, 30);
      const allowed = ["New", "Contacted", "Approved", "Rejected"];
      if (!id || !allowed.includes(status)) return json({ error: "missing id or invalid status" }, 400);

      const existing = await store.get(id, { type: "json" });
      if (!existing) return json({ error: "not found" }, 404);
      existing.status = status;
      existing.dateUpdated = new Date().toISOString();
      await store.setJSON(id, existing);

      return json({ ok: true, application: existing });
    }

    if (action === "deleteApplication") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const id = clean(body.id, 20);
      if (!id) return json({ error: "missing id" }, 400);
      await store.delete(id);

      return json({ ok: true });
    }

    if (action === "getSettings") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const settingsStore = getStore({ name: "affiliate-application-settings", consistency: "strong" });
      const settings = await settingsStore.get("config", { type: "json" });
      return json({ ok: true, settings: settings || { notificationEmail: "" } });
    }

    if (action === "setSettings") {
      const denied = await requireAdmin();
      if (denied) return denied;

      const notificationEmail = clean(body.notificationEmail, 600);
      if (badEmails(notificationEmail).length) return json({ ok: false, error: "\"" + badEmails(notificationEmail)[0] + "\" doesn't look like an email address. Separate several addresses with a comma." }, 400);
      const settingsStore = getStore({ name: "affiliate-application-settings", consistency: "strong" });
      await settingsStore.setJSON("config", { notificationEmail: notificationEmail });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
};

export const config = { path: "/api/affiliate-application" };
