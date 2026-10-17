import { getStore } from "https://esm.sh/@netlify/blobs@8?bundle";
import { slug, saveListingFile } from "./lib/listing-files.js";

// Handles document + image uploads for the Property Affiliate onboarding
// form (proof of ownership, proof of residence, ID, mandate, property/unit
// photos). Mirrors the existing hook-image.js pattern: raw binary body in,
// a stable key back out, GET to retrieve later for admin review.

const MAX_BYTES = 10 * 1024 * 1024; // 10MB — covers scanned PDFs + photos

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
  const store = getStore({ name: "property-listing-files", consistency: "strong" });

  try {
    if (request.method === "POST") {
      const listingId = slug(url.searchParams.get("listingId"));
      const kind = slug(url.searchParams.get("kind")); // "document" | "image"
      const label = slug(url.searchParams.get("label")); // e.g. "proof-of-ownership", "unit-main-house"
      const fileName = (url.searchParams.get("fileName") || "upload").trim().slice(0, 200);

      if (!listingId || !kind || !label) {
        return new Response(JSON.stringify({ error: "missing listingId, kind, or label" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      const contentType = request.headers.get("content-type") || "application/octet-stream";
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) {
        return new Response(JSON.stringify({ error: "file too large (max 10MB)" }), {
          status: 413,
          headers: { "content-type": "application/json", ...cors },
        });
      }
      if (buf.byteLength < 1) {
        return new Response(JSON.stringify({ error: "empty file" }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
      }

      const key = await saveListingFile(store, { listingId, kind, label, fileName, contentType, data: buf });

      return new Response(JSON.stringify({ ok: true, key: key, fileName: fileName }), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    // GET — retrieve a stored file by its key (used for admin review).
    const key = url.searchParams.get("key") || "";
    if (!key) {
      return new Response(JSON.stringify({ error: "missing key" }), {
        status: 400,
        headers: { "content-type": "application/json", ...cors },
      });
    }

    const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!result) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json", ...cors },
      });
    }

    const contentType = (result.metadata && result.metadata.contentType) || "application/octet-stream";
    return new Response(result.data, {
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=300",
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

export const config = { path: "/api/property-file" };
