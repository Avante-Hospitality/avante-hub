import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { sha256Hex } from "./lib/image-hash.js";
import { mergeIntoRecord, AI_SCAN_CACHE_FIELDS_CLEARED } from "./lib/record-merge.js";
import { purgeHookListCache } from "./lib/hook-cache.js";

const MAX_BYTES = 5 * 1024 * 1024;

export default async (request, context) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
};

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
}

  const url = new URL(request.url);
  // /api/hook-image/v/<aff>/<hook>/<version> — the front store's long-cached
  // copy of a hook's one fixed picture (the version comes from the hook
  // list, lib/hook-cache.js hookImageVersion, and changes with the
  // picture). GET only; no query string, so the Image CDN can resize it.
  const versioned = url.pathname.match(/^\/api\/hook-image\/v\/([^/]+)\/([^/]+)\/[A-Za-z0-9]+\/?$/);
  if (versioned && request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { "content-type": "application/json", ...cors } });
  }
  const aff = versioned ? decodeURIComponent(versioned[1]).trim() : (url.searchParams.get("aff") || "").trim();
  const hook = versioned ? decodeURIComponent(versioned[2]).trim() : (url.searchParams.get("hook") || "").trim();
  // Optional — only ever used to GET one of the extra gallery photos a
  // hook's Auto-build "Use this" step may have saved (see admin-api.js's
  // saveHookPhotos). Distinguish "no ?slot= at all" (every single-image
  // caller — Hub, Share Kit, admin preview — which wants the rotation
  // below) from an explicit "?slot=0" (hook-landing.html's gallery asking
  // for its deterministic first frame, the cover, by index): both read
  // the same bare aff:hook key, but only the former should rotate.
  const hasSlot = versioned ? true : url.searchParams.has("slot");
  const slot = versioned ? "" : (url.searchParams.get("slot") || "").trim();

  if (!aff || !hook) {
    return new Response(JSON.stringify({ error: "missing aff or hook" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
});
}

  const store = getStore({ name: "promo-hook-images", consistency: "strong" });
  // Read for GET rotation below; also read+written by DELETE, which clears
  // a hook's galleryCount back to 0 once its photos are gone (see below).
  const hookStore = getStore({ name: "promo-hooks", consistency: "strong" });
  let key = slot && slot !== "0" ? aff + ":" + hook + ":" + slot : aff + ":" + hook;

  try {
    if (request.method === "DELETE") {
      // Removes this hook's current image entirely (cover photo plus any
      // extra gallery slots Auto-build's photo picker saved alongside it —
      // otherwise the cover key would be gone but the GET rotation above
      // would still occasionally serve one of the now-orphaned gallery
      // slots at random, making "delete image" look like it didn't work).
      let galleryCount = 0;
      let readFailed = false;
      let hadAnythingToClean = false;
      try {
        const record = await hookStore.get(aff + ":" + hook, { type: "json" });
        galleryCount = (record && record.galleryCount) || 0;
        hadAnythingToClean = !!(
          record &&
          (galleryCount > 0 || record.imageHash || record.aiCaption || record.aiHashtags || record.aiImageHash)
        );
      } catch (e) {
        // best-effort — if this lookup fails we still delete the cover key
        // below, but galleryCount stays 0 here purely because we don't
        // know the real count, not because there isn't one — readFailed
        // tracks that distinction so the cleanup write below doesn't lie
        // about it (see there for why that matters). A real gallery's
        // slots 1..N are left undeleted this time (we don't know N), so
        // GET's rotation could still occasionally serve one — but because
        // the record keeps correctly saying a gallery exists rather than
        // claiming 0, simply retrying Delete once this transient failure
        // has passed will find the real count and finish the job, instead
        // of silently losing track of those slots forever.
        readFailed = true;
      }

      const keysToDelete = [aff + ":" + hook];
      for (let s = 1; s <= galleryCount; s++) keysToDelete.push(aff + ":" + hook + ":" + s);
      await Promise.all(keysToDelete.map((k) => store.delete(k).catch(() => {})));

      // The AI-cache fields are always safe to clear here — the cover key
      // is unconditionally in keysToDelete above, so the cover image really
      // is gone regardless of whether the lookup above succeeded, and a
      // transient read failure must never be the reason a stale
      // imageHash/aiCaption/aiHashtags/aiImageHash survives it (they'd
      // otherwise go on matching each other forever, serving a cached
      // caption for an image that's now simply gone).
      //
      // galleryCount is different: claiming it's now 0 is only true when
      // we actually know that and deleted every real gallery slot above —
      // if the lookup failed, there might be a real gallery whose slots
      // were never touched (galleryCount stayed 0 above for the wrong
      // reason), and writing galleryCount:0 anyway would permanently lose
      // track of those still-live blobs (nothing would ever look for them
      // again — this exact bug shipped once already in an earlier fix
      // here, caught by review). So galleryCount is only included in the
      // merge when we're sure.
      //
      // mergeIntoRecord's re-read-before-write only protects fields NOT
      // present in this merge from a stale overwrite — it can't protect
      // galleryCount itself from being stale, since it IS being written
      // here. Known, accepted narrow race, the same class already
      // documented in admin-api.js's saveHookPhotos and hook-image.js's
      // own upload path above: if Auto-build's saveHookPhotos writes a
      // fresh, larger gallery for this exact hook in the real-world gap
      // between reading galleryCount here and the Promise.all delete +
      // this merge (a real network round-trip in between), that fresh
      // gallery's slot blobs get orphaned and galleryCount reverts to 0
      // anyway. Not fixed for the same reason given at the other two
      // sites — two different admin actions racing on the identical hook
      // within the same narrow window, recoverable by re-running
      // whichever one lost.
      //
      // None of this runs at all when the read succeeded and genuinely
      // found nothing (a hook that never had an image, or doesn't exist)
      // — this endpoint is unauthenticated, so an unconditional write
      // regardless of whether there's anything to clean would let anyone
      // create a throwaway "promo-hooks" record for any random aff/hook
      // pair just by calling DELETE on it, growing that store forever and
      // slowing down admin tools that list every record in it. A failed
      // read still always writes (readFailed below) since in that case we
      // genuinely don't know, and erring toward cleanup is the safer
      // default there.
      if (readFailed || hadAnythingToClean) {
        const cleanupFields = {
          ...AI_SCAN_CACHE_FIELDS_CLEARED,
          imageHash: undefined,
          updatedAt: new Date().toISOString(),
        };
        if (!readFailed) cleanupFields.galleryCount = 0;
        await mergeIntoRecord(hookStore, aff + ":" + hook, cleanupFields);
        purgeHookListCache(context, aff); // front stores get the new picture version
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...cors },
});
}

    if (request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        return new Response(JSON.stringify({ error: "file must be an image" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
});
}

      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) {
        return new Response(JSON.stringify({ error: "image too large (max 5MB)" }), {
          status: 413,
          headers: { "content-type": "application/json", ...cors },
});
}

      await store.set(key, buf, { metadata: { contentType } });

      // A plain manual upload (no ?slot=) always replaces this hook's
      // *whole* image, not just its cover frame — so any leftover
      // Auto-build gallery photos from before must go too. Without this,
      // they'd sit around referenced by galleryCount and the GET rotation
      // above would keep occasionally serving one of them at random,
      // instead of the image just uploaded. An explicit ?slot= POST (no
      // current caller sends one, but defensively) is a single-slot
      // write, not a full replace, so it skips this.
      //
      // Also records a content hash of the new image, so
      // hook-share-content.js's AI caption scan can tell a genuinely new
      // image apart from the same one being re-saved, and re-scan only
      // when it actually needs to. Any previously cached AI caption is
      // left in place here (not cleared) — hook-share-content.js compares
      // hashes itself and only trusts a cached caption whose hash still
      // matches this new one, which it never will after this write.
      //
      // Every upload now takes this branch (not just a gallery reset, as
      // before imageHash existed), so unlike before it runs unconditionally
      // — written via mergeIntoRecord (re-reads fresh right before writing)
      // rather than mutating and writing back the `record` read below,
      // which only exists to decide whether a gallery reset is needed and
      // which stale slots to delete; writing it back directly on every
      // single upload would risk clobbering a concurrent caption/booking
      // save to this same record far more often than the old,
      // gallery-reset-only write path ever could.
      //
      // Accepted, pre-existing-class limitation: this whole endpoint is
      // unauthenticated (same trust model as hook-pdf.js), so an upload to
      // any made-up aff/hook pair already creates a real image blob
      // regardless of this write — this hookStore record is small
      // incremental metadata on top of storage abuse that was already
      // possible before this feature existed, not a new attack surface of
      // its own, and every genuine upload needs its hash recorded here
      // for the AI-scan cache to work at all, so gating this write the
      // way DELETE's cleanup is gated below isn't an option without
      // breaking that for legitimate uploads too.
      // Known, accepted narrow race (not fixed — see reasoning below):
      // galleryCount here is read once, before the sha256Hex await, and
      // used to decide both which gallery slots to physically delete and
      // whether to merge galleryCount:0 afterward. mergeIntoRecord's own
      // re-read-before-write protects every *other* field from being
      // clobbered, but it can't retroactively validate a decision already
      // acted on using stale data — if admin-api.js's saveHookPhotos
      // (Auto-build) writes a fresh, different gallery for this exact
      // hook in the moment between this read and this branch's writes,
      // this upload could still delete Auto-build's newly-saved slot
      // blobs and reset its galleryCount back to 0. Fixing that fully
      // would need real per-hook locking around the delete+write pair,
      // not just a smarter merge — disproportionate for what this is: two
      // different admin actions (a manual cover upload and Auto-build's
      // multi-photo picker) targeting the identical hook within the same
      // sub-second window, recoverable by simply re-running Auto-build.
      if (key === aff + ":" + hook) {
        try {
          const record = (await hookStore.get(key, { type: "json" })) || {};
          const galleryCount = record.galleryCount || 0;
          if (galleryCount > 0) {
            const staleSlots = [];
            for (let s = 1; s <= galleryCount; s++) staleSlots.push(key + ":" + s);
            await Promise.all(staleSlots.map((k) => store.delete(k).catch(() => {})));
          }
          const hash = await sha256Hex(buf);
          const fields = { imageHash: hash, updatedAt: new Date().toISOString() };
          if (galleryCount > 0) fields.galleryCount = 0;
          await mergeIntoRecord(hookStore, key, fields);
          purgeHookListCache(context, aff); // front stores get the new picture version
        } catch (e) {
          // best-effort — the cover upload above already succeeded either way.
          // Logged: if the record didn't get the new hash, the front store's
          // long-cached picture (/api/hook-image/v/...) keeps the old one
          // until this hook is saved again.
          console.error("hook-image.js: upload saved but its record update failed —", String((e && e.message) || e));
        }
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...cors },
});
}

    // GET, no ?slot= at all: if this hook has extra gallery photos (saved
    // by Auto-build's photo picker), rotate — pick a random one of the
    // saved photos (the cover or any gallery slot) on every request
    // instead of always the same fixed cover, so every place this image
    // shows (Hub, Share Kit, admin preview) naturally cycles through the
    // set. A hook with no gallery photos (the overwhelming majority —
    // anything not built with Auto-build's multi-photo picker) behaves
    // exactly as before: the one key it has ever had. An explicit
    // ?slot=0 (hook-landing.html's gallery asking for its first frame by
    // index) is deliberately excluded from rotation — it wants that exact
    // frame, not a random one.
    if (!hasSlot) {
      try {
        const hookRecord = await hookStore.get(aff + ":" + hook, { type: "json" });
        const galleryCount = (hookRecord && hookRecord.galleryCount) || 0;
        if (galleryCount > 0) {
          const pick = Math.floor(Math.random() * (galleryCount + 1)); // 0 = cover, 1..N = gallery slots
          if (pick > 0) key = aff + ":" + hook + ":" + pick;
        }
      } catch (e) {
        // best-effort — any lookup failure just falls back to the cover key
      }
    }

    const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!result) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
});
}

    const contentType = (result.metadata && result.metadata.contentType) || "application/octet-stream";
    return new Response(result.data, {
      headers: {
        "content-type": contentType,
        // The versioned copy never changes, so browsers and Netlify's CDN keep
        // it for a year. The plain URL may rotate gallery photos or change
        // with the next upload, so the CDN never keeps it (same as before
        // cache: "manual" below).
        "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
        "netlify-cdn-cache-control": versioned ? "public, s-maxage=31536000, immutable" : "no-store",
        ...cors,
},
});
} catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...cors },
});
}
};

// cache: "manual" lets Netlify's CDN keep the versioned copy (the only
// response that allows it, see above).
export const config = { path: ["/api/hook-image", "/api/hook-image/v/*"], cache: "manual" };
