// Scrapes a StockNetwork resort's public info page
// (old.stocknetwork.co.za/ResortInfo.aspx) for real marketing content —
// name, description, attractions, room type, and its actual photo gallery —
// and turns that into an AI-drafted hook caption. Used by admin-api.js's
// generateHookDraft action to let an admin build a hook from just a
// property or an area/district, instead of typing everything by hand.
//
// Lives in netlify/edge-functions/lib/ (not directly in edge-functions/) so
// Netlify doesn't try to auto-register it as its own routed function — same
// reason hashtag-helper.js and booking-stats.js live here too.
//
// Design notes (verified live against the real site before writing this):
// - ResortInfo.aspx is plain server-rendered ASP.NET, NOT a client-side app
//   — a bare fetch()+text() already contains everything, no headless
//   browser or JS execution needed.
// - There are no Open Graph tags, so every field is pulled by matching the
//   page's own ASP.NET server-label ids (id="lblAboutUs" etc.), which are
//   far more stable than matching surrounding layout markup.
// - The photo carousel's <img> tags use single-quoted src attributes,
//   unlike the rest of the page — the regex below matches either quote
//   style so it doesn't silently return zero photos if that ever changes.

const RESORT_INFO_BASE = "https://old.stocknetwork.co.za/ResortInfo.aspx";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Pulls the text content of a `<h5 id="lblXxx">...</h5>` ASP.NET label.
function extractLabel(html, id) {
  const re = new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)<\\/h5>', "i");
  const m = html.match(re);
  return m ? stripTags(m[1]) : "";
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]) : "";
}

function extractRoomType(html) {
  const m = html.match(/Room Type:<span>\s*([^<]*)<\/span>/i);
  return m ? stripTags(m[1]) : "";
}

// The resort's photo carousel lives inside <div id="dvResortImages">...
// one <img src='...'/> per photo. Returns deduped, ordered full-size CDN
// URLs (StockNetwork's own professional photography of that exact unit).
function extractGalleryImages(html) {
  const wrapIdx = html.indexOf('id="dvResortImages"');
  const scope = wrapIdx >= 0 ? html.slice(wrapIdx, wrapIdx + 40000) : html;
  const urls = [];
  const re = /<img[^>]+src=['"]([^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(scope))) {
    // Stock Network writes its photo addresses relative to its own site
    // (/data/resort/<id>/…); make them full addresses (Jean, 2026-10-16:
    // Silver Ranch's photos weren't filling in because of this).
    let url = "";
    try { url = new URL(m[1], RESORT_INFO_BASE).href; } catch (e) { continue; }
    if (!/\/data\/resort\/|\/image\/\d+\/gallery\//i.test(url)) continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Fetches and parses one resort's public info page. Returns null (rather
// than throwing) on any failure — a bad/retired ResortID shouldn't break a
// whole draft, just contribute nothing to it.
export async function fetchResortInfo(resortId, siteId) {
  if (!resortId) return null;
  try {
    const url =
      RESORT_INFO_BASE +
      "?ResortID=" +
      encodeURIComponent(resortId) +
      (siteId ? "&SiteID=" + encodeURIComponent(siteId) : "");
    const res = await fetch(url);
    if (!res.ok) return null;
    const html = await res.text();

    const name = extractTitle(html);
    const description = extractLabel(html, "lblAboutUs");
    const attractions = extractLabel(html, "lblAttractions");
    const moreInfo = extractLabel(html, "lblMoreInfo");
    const roomType = extractRoomType(html);
    const images = extractGalleryImages(html);

    if (!name && !description && !images.length) return null;

    return {
      resortId: resortId,
      siteId: siteId || "",
      name: name,
      description: description,
      attractions: attractions,
      moreInfo: moreInfo,
      roomType: roomType,
      images: images,
      sourceUrl: url,
    };
  } catch (e) {
    return null;
  }
}

const CAPTION_TOOL = {
  name: "set_hook_caption",
  description: "Return a short, high-engagement travel promo caption ready to post on social media.",
  input_schema: {
    type: "object",
    properties: {
      caption: {
        type: "string",
        description:
          "A punchy 2-4 sentence promo caption (with an attention-grabbing opening line), written for a South African travel audience, based only on the supplied property/destination details — don't invent anything not supported by them. No hashtags (those are generated separately), at most 1-2 emoji, no markdown.",
      },
    },
    required: ["caption"],
  },
};

// Drafts a hook caption from scraped property/area content via Claude —
// same call pattern as hashtag-helper.js's generateHashtags, so the two
// share the same failure behaviour: a missing key, network error, or bad
// response returns null rather than throwing, so a draft request degrades
// gracefully instead of failing the whole action.
export async function draftHookCaption(input) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const mode = input && input.mode === "area" ? "area" : "property";
  const label = (input && input.label) || "";
  const sources = Array.isArray(input && input.sources) ? input.sources : [];
  if (!sources.length) return null;

  const sourceText = sources
    .map(function (s, i) {
      const lines = [
        "Property " + (i + 1) + ": " + (s.name || ""),
        s.roomType ? "Type: " + s.roomType : "",
        s.description ? "About: " + s.description : "",
        s.attractions ? "Nearby: " + s.attractions : "",
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");

  const instruction =
    mode === "area"
      ? "Write a promo caption for " +
        label +
        " as a destination, drawing on the real properties below that are available to book there:"
      : "Write a promo caption for this specific property (" + label + "):";

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        tools: [CAPTION_TOOL],
        tool_choice: { type: "tool", name: "set_hook_caption" },
        messages: [{ role: "user", content: instruction + "\n\n" + sourceText }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const toolUse = Array.isArray(data.content)
      ? data.content.find((b) => b.type === "tool_use" && b.name === "set_hook_caption")
      : null;
    const caption =
      toolUse && toolUse.input && typeof toolUse.input.caption === "string" ? toolUse.input.caption.trim() : "";
    return caption || null;
  } catch (e) {
    return null;
  }
}
