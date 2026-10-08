import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { generateHashtags } from "./lib/hashtag-helper.js";
import { resolveShortLink as resolveShortLinkShared, isShortLink } from "./lib/short-link.js";
import { correctBookingLinkSiteId, ADMIN_MASTER_SITE_GUID } from "./lib/booking-link.js";
import { resolveHookMode } from "./lib/hook-mode.js";
import { buildHookDraft } from "./lib/hook-draft.js";
import { saveHookPhotoUrls } from "./lib/hook-photos.js";
import { defaultTemplateForCategory } from "./lib/hook-templates.js";
import { resolveFlyerFields, defaultPhotoSlotOrder } from "./lib/hook-flyer.js";
import { renderFlyerSVG } from "./lib/hook-flyer-svg.js";
import { fetchFlyerImages } from "./lib/hook-flyer-images.js";
import { rememberTheme } from "./lib/event-themes.js";
import { searchPlacePhotos } from "./lib/places-images.js";
import { dataUriToBytes } from "./lib/data-uri.js";
import { sha256Hex } from "./lib/image-hash.js";
import { mergeIntoRecord, AI_SCAN_CACHE_FIELDS_CLEARED } from "./lib/record-merge.js";

// Special affiliate key reserved for admin-managed default hook content.
// Chosen so it can never collide with a real affiliate ID (StockNetwork
// GUIDs / affiliate numbers never contain double underscores).
const ADMIN_KEY = "__admin__";

// StockNetwork's "/ui/<id>" booking links carry the site identifier as the
// last path segment. Self-managed hooks put the affiliate's own Hub ID
// there; an admin-authored default hook instead uses Jean's own master
// site GUID (ADMIN_MASTER_SITE_GUID) as a placeholder, so the booking can
// be re-attributed to whichever affiliate is actually viewing it. Earlier
// admin default hooks were built with a literal "Affiliate <number>" text
// segment instead — confirmed NOT to be a real StockNetwork site
// identifier (it doesn't open the site it names), but still recognized
// here too so any hook not yet rebuilt with the real GUID still gets
// personalized rather than silently shown broken. Any other URL shape is
// left untouched — we only ever touch a link we can confidently recognize.
function personalizeStockNetworkUrl(rawUrl, replacement) {
  if (!rawUrl || !replacement) return rawUrl;
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split("/");
    let lastIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]) { lastIdx = i; break; }
    }
    if (lastIdx === -1) return rawUrl;
    let seg;
    try {
      seg = decodeURIComponent(parts[lastIdx]);
    } catch (e) {
      return rawUrl;
    }
    const isPlaceholder = seg === ADMIN_MASTER_SITE_GUID || /^Affiliate\s+\d+$/i.test(seg);
    if (!isPlaceholder) return rawUrl;
    parts[lastIdx] = encodeURIComponent(replacement);
    u.pathname = parts.join("/");
    return u.toString();
  } catch (e) {
    return rawUrl;
  }
}

// If the admin's stored booking link is one of our own shortened
// go.avantetravel.co.za links, resolve it back to the real destination so
// we have something we can actually personalize. Falls back to the
// original URL untouched if it isn't one of ours or the lookup fails.
async function resolveShortLink(rawUrl) {
  const shortStore = getStore({ name: "short-links", consistency: "strong" });
  return resolveShortLinkShared(rawUrl, shortStore);
}

function withAffiliate(landing, aff) {
  try {
    const u = new URL(landing);
    if (!/^\/l\/[a-z0-9-]+\/?$/.test(u.pathname) || !/^[0-9a-f-]{36}$/i.test(String(aff || ""))) return landing;
    u.searchParams.set("a", aff);
    return u.toString();
  } catch (e) { return landing; }
}

async function personalizeBooking(rawUrl, replacement) {
  const resolved = await resolveShortLink(rawUrl);
  return personalizeStockNetworkUrl(resolved, replacement);
}

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  const aff = (url.searchParams.get("aff") || "").trim();
  const hook = (url.searchParams.get("hook") || "").trim();

  if (!aff || !hook) {
    return new Response(JSON.stringify({ error: "missing aff or hook" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const store = getStore({ name: "promo-hooks", consistency: "strong" });
  const key = aff + ":" + hook;

  try {
    if (request.method === "POST") {
      const body = await request.json();

      // Auto-build for a self-managed hook — the same "draft from a
      // property or area" flow admin-api.js's generateHookDraft action has
      // always offered for Default Hooks, available here too so an
      // affiliate can build their own hook the identical way (hub.html's
      // "Auto-build" panel). Nothing about the plain manual save path
      // below changes — this is purely an extra, opt-in action reached by
      // sending action: "draft" instead of the usual field updates.
      // `aff` doubles as this affiliate's own real StockNetwork site GUID
      // (see personalizeStockNetworkUrl's comment above and the "Add
      // Affiliate" modal, which requires exactly that) — used directly as
      // the booking link's site identifier here, unlike the admin's
      // placeholder-then-personalize approach, since it's already this
      // affiliate's own link and needs no re-attribution.
      if (body.action === "draft") {
        const resortStore = getStore({ name: "resort-list", consistency: "strong" });
        const draft = await buildHookDraft(resortStore, {
          resortId: body.resortId,
          siteId: body.siteId,
          query: body.query,
          // The multi-select Browse-by-location tree's explicit picks —
          // see admin-api.js's identical forwarding and lib/hook-draft.js
          // for what these do.
          resortKeys: body.resortKeys,
          label: body.label,
          bookingSiteGuid: aff,
        });
        return new Response(JSON.stringify(draft), {
          status: draft.ok ? 200 : draft.status || 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      // Saves the photos an affiliate picked from a "draft" call above —
      // the self-managed equivalent of admin-api.js's saveHookPhotos
      // action. Keyed by this exact hook's own aff:hook key, same as
      // every other store/read on this hook already is.
      if (body.action === "savePhotos") {
        const urls = Array.isArray(body.urls)
          ? body.urls.filter((u) => typeof u === "string" && u.trim()).slice(0, 6)
          : [];
        if (!urls.length) {
          return new Response(JSON.stringify({ ok: false, error: "No photos selected." }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        const imageStore = getStore({ name: "promo-hook-images", consistency: "strong" });
        const result = await saveHookPhotoUrls(store, imageStore, key, urls, body.source);
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 502,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      // Persists a per-hook override of contactPhone/contactEmail — backend
      // parity with admin-api.js's identical saveFlyerContact action, keyed
      // by this exact hook's own aff:hook key so an affiliate managing
      // their own self-managed hook can set their own contact details on
      // it, distinct from the shared account-wide default (or from any
      // other hook). Saving an empty string clears the override.
      if (body.action === "saveFlyerContact") {
        const existingForContact = (await store.get(key, { type: "json" })) || {};
        const flyerContactPhone = typeof body.contactPhone === "string" ? body.contactPhone.trim().slice(0, 60) : "";
        const flyerContactEmail = typeof body.contactEmail === "string" ? body.contactEmail.trim().slice(0, 200) : "";
        const record = { ...existingForContact, flyerContactPhone: flyerContactPhone, flyerContactEmail: flyerContactEmail, savedAt: new Date().toISOString() };
        await store.setJSON(key, record);
        return new Response(JSON.stringify({ ok: true, flyerContactPhone: flyerContactPhone, flyerContactEmail: flyerContactEmail }), {
          headers: { "content-type": "application/json", ...cors },
        });
      }

      // Builds a finished flyer SVG for THIS hook (admin's or an
      // affiliate's own self-managed one) — same "nothing invented"
      // resolution + rendering admin-api.js's renderFlyer action uses for
      // Default Hooks, no Canva API call. Needs the hook to already have
      // Auto-build content saved (this exact key's own `source`/photos —
      // an affiliate generating a flyer for their own self-managed hook
      // needs to have Auto-built it first, same as admin does for Default
      // Hooks).
      if (body.action === "renderFlyer") {
        const record = await store.get(key, { type: "json" });
        if (!record) {
          return new Response(JSON.stringify({ ok: false, error: "This hook has no saved content yet — build or save it first." }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        // Which template this hook uses — its own saved `category` (see
        // the plain save path below), defaulting to "property" for every
        // hook saved before Event hooks existed.
        const template = defaultTemplateForCategory(record.category || "property");
        if (!template) {
          return new Response(JSON.stringify({ ok: false, error: "No flyer template registered yet." }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        const templateId = record.category === "event" ? "event-flyer-v1" : "property-flyer-v1";
        const settingsStore = getStore({ name: "flyer-settings", consistency: "strong" });
        const contactSettings = (await settingsStore.get("config", { type: "json" })) || {};
        const overrides = body.fields && typeof body.fields === "object" ? body.fields : null;
        const { values, missing } = resolveFlyerFields(template, record, contactSettings, overrides);

        const imageStore = getStore({ name: "promo-hook-images", consistency: "strong" });
        const slotKeys = defaultPhotoSlotOrder(template);
        const images = await fetchFlyerImages(imageStore, key, record.galleryCount || 0, slotKeys);

        const svg = renderFlyerSVG(template, values, images);
        return new Response(
          // `source` included alongside key/role — see admin-api.js's
          // identical renderFlyer action for why (lets admin.html/hub.html
          // point a "jean-settings" field like contactPhone/contactEmail at
          // the shared Flyer contact info box instead of a per-hook input).
          JSON.stringify({ ok: true, templateId: templateId, fields: template.fields.map((f) => ({ key: f.key, role: f.role, source: f.source })), values: values, missing: missing, svg: svg }),
          { headers: { "content-type": "application/json", ...cors } }
        );
      }

      // Backend parity with admin-api.js's findPlaceImages — see
      // lib/places-images.js for why this exists and never hands a raw
      // Google Places URL to the caller. No hub.html UI calls this yet
      // (Event hooks are admin-curated content for now, same note as the
      // category/theme fields above), added here purely so a self-managed
      // record never breaks if that changes.
      if (body.action === "findPlaceImages") {
        const query = typeof body.query === "string" ? body.query.trim().slice(0, 200) : "";
        const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY") || "";
        const result = await searchPlacePhotos(query, apiKey, body.limit);
        return new Response(JSON.stringify(result), { headers: { "content-type": "application/json", ...cors } });
      }

      // Backend parity with admin-api.js's savePlacePhoto — same
      // cover/gallery-slot keying and cache-invalidation rules, see there
      // for the full reasoning.
      if (body.action === "savePlacePhoto") {
        const slot = body.slot === "secondary" ? "secondary" : "hero";
        const parsed = dataUriToBytes(body.dataUri);
        if (!parsed) {
          return new Response(JSON.stringify({ ok: false, error: "No image data received." }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        if (parsed.buf.byteLength > 5 * 1024 * 1024) {
          return new Response(JSON.stringify({ ok: false, error: "Image too large (max 5MB)." }), {
            status: 413,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        const imageStore = getStore({ name: "promo-hook-images", consistency: "strong" });
        const imageKey = slot === "secondary" ? key + ":1" : key;
        await imageStore.set(imageKey, parsed.buf, { metadata: { contentType: parsed.contentType, sourceUrl: "google_places" } });

        if (slot === "hero") {
          const existingForPhoto = (await store.get(key, { type: "json" })) || {};
          const newHash = await sha256Hex(parsed.buf);
          const fields = { imageHash: newHash, updatedAt: new Date().toISOString() };
          if (newHash !== existingForPhoto.imageHash) Object.assign(fields, AI_SCAN_CACHE_FIELDS_CLEARED);
          await mergeIntoRecord(store, key, fields);
        } else {
          const existingForPhoto = (await store.get(key, { type: "json" })) || {};
          const galleryCount = Math.max(existingForPhoto.galleryCount || 0, 1);
          await mergeIntoRecord(store, key, { galleryCount: galleryCount, updatedAt: new Date().toISOString() });
        }

        return new Response(JSON.stringify({ ok: true, slot: slot }), { headers: { "content-type": "application/json", ...cors } });
      }

      const existing = (await store.get(key, { type: "json" })) || {};
      const record = { ...existing };

      if (typeof body.booking === "string") record.booking = body.booking;
      if (typeof body.landing === "string") record.landing = body.landing;
      // A StockNetwork booking link's site identifier not matching this
      // affiliate's own id is the specific mistake admin-api.js's
      // fixMisattributedHookLinks exists to clean up (see there for the
      // full story: it silently sends every booking through this hook to
      // whoever that other id belongs to instead) — guard against writing
      // that state back here too, so it can't be immediately re-created
      // after being fixed. `aff` is this exact hook's own affiliate, from
      // the ?aff= this request came in on — always the right id to
      // enforce here, EXCEPT for ADMIN_KEY itself: this endpoint has no
      // auth check at all, and admin's own default hook record
      // (aff === ADMIN_KEY) is *supposed* to keep carrying the shared
      // ADMIN_MASTER_SITE_GUID placeholder (see personalizeStockNetworkUrl
      // above), not get "corrected" to the literal string "__admin__" —
      // which would break personalization for every affiliate this default
      // hook still serves. fixMisattributedHookLinks already excludes
      // ADMIN_KEY records the same way.
      //
      // The misattribution can hide behind one of our own short links
      // too (shortened, then pasted somewhere raw) — resolve one before
      // checking, or this would only ever see "go.avantetravel.co.za" and
      // never the real destination underneath. Only rewrites booking when
      // a correction is actually needed — an already-correct short link
      // is left exactly as saved, not eagerly unshortened.
      if (aff !== ADMIN_KEY && record.booking) {
        const resolvedForCheck = isShortLink(record.booking) ? await resolveShortLink(record.booking) : record.booking;
        const bookingCheck = correctBookingLinkSiteId(resolvedForCheck, aff);
        if (bookingCheck.changed) record.booking = bookingCheck.url;
      }
      // Booking link and Landing page link ending up set to the exact
      // same short link is the specific mistake admin-api.js's
      // fixCollapsedHookLinks exists to clean up (see there for the full
      // story) — guard against writing that state back here too, so it
      // can't be immediately re-created after being fixed.
      if (record.landing && record.landing === record.booking && isShortLink(record.booking)) {
        record.landing = "";
      }
      if (typeof body.caption === "string") {
        record.caption = body.caption;
        // Regenerate platform hashtags whenever the caption is (re)saved.
        // Best-effort: a failed/unavailable AI call just clears the cached
        // set rather than blocking the save.
        const newHashtags = await generateHashtags(record.caption);
        if (newHashtags) record.hashtags = newHashtags;
        else delete record.hashtags;
      }
      // Where this hook's property (or campaign selection) is — a plain
      // human-readable string now, computed client-side from the
      // Browse-by-location tree's ticked properties/suburbs/towns
      // whenever Auto-build runs (see lib/hook-draft.js's locationLabel).
      // There's no separate "pick a location" field any more (the old
      // dropdown is gone — the tree is the only source of location), so
      // this is only ever sent right after a fresh Auto-build draft; any
      // other save just keeps whatever was last set.
      if (typeof body.locationLabel === "string") record.locationLabel = body.locationLabel;
      // Flyer-template-only fields (see lib/hook-templates.js) — price and
      // the promo banner/date range. StockNetwork has no static rate field
      // (price is dates-dependent) and the banner/dates are campaign-
      // specific, so both always have to be typed in here, same as admin's
      // own Default Hooks form. Optional: left blank just leaves that box
      // unfilled on the flyer, nothing invented to fill the gap.
      if (typeof body.flyerPromoTag === "string") record.flyerPromoTag = body.flyerPromoTag.trim().slice(0, 200);
      if (typeof body.flyerPrice === "string") record.flyerPrice = body.flyerPrice.trim().slice(0, 200);
      if (typeof body.flyerDates === "string") record.flyerDates = body.flyerDates.trim().slice(0, 200);
      // Which flyer template this hook uses — see admin-api.js's
      // setDefaultHook for the same handling. Not currently exposed in
      // hub.html's self-managed hook UI (Event hooks are admin-curated
      // content for now), but accepted here too so a self-managed record
      // never breaks if that changes.
      if (body.category === "property" || body.category === "event") record.category = body.category;
      const EVENT_TEXT_FIELDS = [
        "eventNameLine1", "eventNameLine2", "eventSubtitle", "eventSectionHeading",
        "eventHighlight1", "eventHighlight2", "eventHighlight3", "eventHighlight4",
        "eventDate", "eventLocationName", "eventLocationDetail",
      ];
      for (const fkey of EVENT_TEXT_FIELDS) {
        if (typeof body[fkey] === "string") record[fkey] = body[fkey].trim().slice(0, 400);
      }
      if (typeof body.eventTheme === "string") {
        record.eventTheme = body.eventTheme.trim().slice(0, 80);
        if (record.eventTheme) {
          const eventThemeStore = getStore({ name: "event-themes", consistency: "strong" });
          await rememberTheme(eventThemeStore, record.eventTheme);
        }
      }
      if (body.mode === "self" || body.mode === "admin") record.mode = body.mode;
      if (!record.mode) record.mode = "admin";
      record.savedAt = new Date().toISOString();

      await store.setJSON(key, record);
      return new Response(JSON.stringify({ ok: true, record: record }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    // GET — resolve what should actually be shown for this hook.
    const affRecord = await store.get(key, { type: "json" });
    const { mode, source, expired } = resolveHookMode(affRecord);

    if (aff === ADMIN_KEY) {
      // The admin's own default record — no resolution needed, just return
      // it as-is, plus a `details` alias for the stored `source` metadata
      // (Auto-build's property/area info) so hook-landing.html can read it
      // the same way it does for every other caller below — without
      // renaming or removing the existing `source` field, which already
      // means something else (rich metadata, not admin/self routing) only
      // on this raw admin record.
      const data = affRecord ? { ...affRecord, details: affRecord.source || null } : null;
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    if (source === "admin") {
      const adminRecord = await store.get(ADMIN_KEY + ":" + hook, { type: "json" });

      let personalizedBooking = adminRecord ? adminRecord.booking || "" : "";
      if (personalizedBooking) {
        // Re-attribute the admin's placeholder booking link to whichever
        // affiliate is actually viewing it, using their own real
        // StockNetwork site GUID (`aff` — the same ID self-managed hooks
        // already use directly as their booking link's site identifier;
        // see the "Add Affiliate" modal, which requires this to match the
        // affiliate's real Hub/StockNetwork ID exactly). Confirmed directly
        // that StockNetwork's numeric "Site Nr" field (used elsewhere for
        // CSV/leaderboard matching only) does NOT work as a /ui/<id> URL
        // segment, so it must never be used here — only a real GUID does.
        try {
          personalizedBooking = await personalizeBooking(personalizedBooking, aff);
        } catch (e) {
          // Best-effort — fall back to the admin's link exactly as saved.
        }
      }

      // "details" carries the real property/area info Auto-build scraped
      // (name, description, attractions, room type) when this hook was
      // built that way — used by the new hook-landing.html page for its
      // "full details" view. Deliberately not called "source" here, since
      // that name is already used below for the admin/self routing field.
      const data = adminRecord
        ? {
            booking: personalizedBooking,
            // A landing page from the hook builder (/l/<name>) opens with this
            // affiliate's ID, so its Book now buttons credit them.
            landing: withAffiliate(adminRecord.landing || "", aff),
            caption: adminRecord.caption || "",
            hashtags: adminRecord.hashtags || null,
            galleryCount: adminRecord.galleryCount || 0,
            details: adminRecord.source || null,
            // Which area/town/suburb the property in this hook is in, set
            // via the admin's Default Hooks location picker (see
            // setDefaultHook in admin-api.js) — passed through as-is so a
            // future caller (e.g. hook-landing.html or the Hub's Explore
            // Map) can match or display it without a second lookup.
            location: { label: adminRecord.locationLabel || "" },
            flyerPromoTag: adminRecord.flyerPromoTag || "",
            flyerPrice: adminRecord.flyerPrice || "",
            flyerDates: adminRecord.flyerDates || "",
            mode: mode,
            source: "admin",
            expired: expired,
          }
        : { mode: mode, source: "admin", expired: expired };
      // If there's genuinely nothing to show (no admin default set either),
      // return null so callers treat this hook slot as inactive — same as
      // the old behaviour for an empty hook.
      const hasContent = adminRecord && (adminRecord.booking || adminRecord.landing);
      return new Response(JSON.stringify(hasContent ? data : null), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    // source === "self". Auto-build is admin-only for now, so galleryCount/
    // details will normally be absent here — passed through defensively
    // for shape consistency with the admin branch above.
    const data = affRecord
      ? {
          booking: affRecord.booking || "",
          landing: affRecord.landing || "",
          caption: affRecord.caption || "",
          hashtags: affRecord.hashtags || null,
          galleryCount: affRecord.galleryCount || 0,
          details: affRecord.source || null,
          location: { label: affRecord.locationLabel || "" },
          flyerPromoTag: affRecord.flyerPromoTag || "",
          flyerPrice: affRecord.flyerPrice || "",
          flyerDates: affRecord.flyerDates || "",
          mode: mode,
          source: "self",
          expired: expired,
        }
      : null;
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", ...cors },
    });
  } catch (err) {
    // Same fix as admin-api.js's identical catch-all — see there for the
    // full reasoning: a raw platform error (e.g. Netlify's own
    // "usage_exceeded" wording for a plan/usage limit) must never reach
    // the screen as-is. `error` is the friendly message a UI should show;
    // `detail` carries the real string for anyone checking logs.
    const detail = String((err && err.message) || err);
    console.error("hook-api.js: unhandled error —", detail);
    const looksLikeUsageLimit = /usage[_ ]?exceeded|quota|rate[_ ]?limit|too many requests/i.test(detail);
    const error = looksLikeUsageLimit
      ? "This is temporarily unavailable — it looks like a usage or plan limit was hit on the server (check your Netlify account's Usage/Billing page). Please try again shortly."
      : "Something went wrong on our end — please try again in a moment.";
    return new Response(JSON.stringify({ ok: false, error: error, detail: detail }), {
      status: 500,
      headers: { "content-type": "application/json", ...cors },
    });
  }
};

export const config = { path: "/api/hook" };
