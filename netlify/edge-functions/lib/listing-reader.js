// Reads screenshots of a property's own listing on another channel (Airbnb,
// Booking.com, LekkeSlaap, ...) and returns the onboarding-form fields it
// can see — used by property-form.html's "Read screenshots" step (via
// property-onboarding-api.js's readScreenshots action).
//
// Jean's rule (2026-10-12/13): a new property's details should conform to
// what it already shows on its other channels, so the form is filled from
// the owner's OWN listing (screenshots they or Avante admin paste in), not
// by scraping the channel. Everything this returns is a suggestion the
// person filling in the form checks and can change; nothing is saved here.
//
// Lives in netlify/edge-functions/lib/ so Netlify doesn't auto-register it
// as its own routed function.

import { callClaudeTool } from "./anthropic-tool-call.js";

const SUPPORTED = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

function buildTool(amenityOptions) {
  return {
    name: "fill_listing_form",
    description:
      "Return the property listing details that are actually visible in the screenshots. Leave a field out (or empty) when the screenshots don't show it — never guess or invent.",
    input_schema: {
      type: "object",
      properties: {
        channel: str("Which site the screenshots are from, e.g. Airbnb, Booking.com, LekkeSlaap. Empty if unclear."),
        propertyName: str("The listing title / property name exactly as shown."),
        propertyType: str("Property type, e.g. Self Catering, Entire rental unit, Guest House, Hotel room."),
        complexName: str("Resort, estate or complex name the property is in, if shown (e.g. 'The Dunes Resort')."),
        streetAddress: str("Full address exactly as shown (street, resort, suburb, postal code, province)."),
        suburb: str("Suburb or village (e.g. Keurboomstrand)."),
        city: str("Town or city (e.g. Plettenberg Bay). Use the breadcrumb if one is shown."),
        region: str("Tourism region if shown (e.g. Garden Route)."),
        province: str("Province/state (e.g. Western Cape)."),
        country: str("Country."),
        channelPlaceName: str("The place name the channel itself puts in its heading, e.g. 'Entire rental unit in Keurboomsrivier' -> 'Keurboomsrivier'."),
        latitude: num("Only if a coordinate is printed on screen. Never estimate from a map."),
        longitude: num("Only if a coordinate is printed on screen. Never estimate from a map."),
        checkInTime: str("Check-in time or window, e.g. '14:00' or '14:00 to 20:00'."),
        checkOutTime: str("Check-out time, e.g. '10:00'."),
        description: str("The listing description text, as shown (do not rewrite it)."),
        houseRules: str("House rules / conditions shown, e.g. 'All ages welcome', 'No parties'."),
        cancellationPolicy: str("Cancellation policy text shown, e.g. 'Free cancellation before 16 Nov 2026'."),
        childPolicy: str("Child policy if shown."),
        accessibility: str("Accessibility features shown, e.g. 'Fixed grab bars for toilet'."),
        hostName: str("Host name and any host facts shown (years hosting, verified, number of properties)."),
        reviewScore: str("Overall review score with its scale, e.g. '4.8/5'."),
        reviewCount: num("Number of reviews."),
        reviewBreakdown: str("Category scores if shown, e.g. 'Cleanliness 5.0, Location 4.5, Value 4.8, Service 4.9, Safety 4.8'."),
        guests: num("Maximum guests the unit sleeps."),
        bedrooms: num("Number of bedrooms."),
        beds: num("Number of beds."),
        bathrooms: num("Number of bathrooms."),
        bedTypes: str("Bed types, e.g. '1 king bed'."),
        bathroomDetails: str("Bathroom details, e.g. 'En-suite: bath, shower, toilet'."),
        unitTypeName: str("A short unit type name for this unit, e.g. 'Studio', '1 Bedroom (en-suite)', '3 Bedroom House'."),
        amenities: {
          type: "array",
          items: { type: "string", enum: amenityOptions },
          description:
            "Amenities the listing shows as INCLUDED, mapped to the closest item from the allowed list. Only include an item when the screenshot clearly shows it. Never include anything shown crossed out / 'Not included'.",
        },
        otherAmenities: {
          type: "array",
          items: { type: "string" },
          description: "Included amenities shown on screen that have no close match in the allowed list, in the channel's own words.",
        },
        notIncluded: {
          type: "array",
          items: { type: "string" },
          description: "Items the listing explicitly shows as NOT included (crossed out), in the channel's own words, e.g. 'Smoke alarm', 'Carbon monoxide alarm', 'Washer'.",
        },
        prices: {
          type: "array",
          description: "Every price shown, with the dates it applies to when the screen shows them.",
          items: {
            type: "object",
            properties: {
              amount: num("Price in rand as a plain number, e.g. 2300."),
              per: { type: "string", enum: ["night", "stay"], description: "Whether the amount is per night or for the whole stay shown." },
              nights: num("Number of nights the price covers when per = stay."),
              checkIn: str("Check-in date of the search shown, as YYYY-MM-DD, if visible."),
              checkOut: str("Check-out date of the search shown, as YYYY-MM-DD, if visible."),
              includesFees: { type: "boolean", description: "True if the screen says prices include all fees." },
              note: str("Anything else about the price, e.g. 'From R1 560', 'sleeps 2'."),
            },
            required: ["amount"],
          },
        },
        unitTypes: {
          type: "array",
          description: "Every unit or room type the material lists (a rate sheet or document often lists several). Leave out if only one unit and it's already described above.",
          items: {
            type: "object",
            properties: {
              name: str("Unit type name, e.g. 'Studio', '2 Bedroom Chalet'."),
              numUnits: num("How many units of this type the property has."),
              sleeps: num("Maximum guests this unit type sleeps."),
              bedrooms: num("Bedrooms in this unit type."),
              description: str("Beds, bathroom and layout of this unit type."),
            },
            required: ["name"],
          },
        },
        rateSeasons: {
          type: "array",
          description:
            "Rates from a rate sheet / tariff document (Excel, Word or PDF): one entry per unit type and date range. rackRate is the public price PER NIGHT FOR THE WHOLE UNIT in rand. If the sheet gives a per-person rate, multiply by the number of guests the unit sleeps and say so in note. If it gives a weekly rate, divide by 7 and say so in note.",
          items: {
            type: "object",
            properties: {
              unitTypeName: str("Unit type the rate is for (same name as in unitTypes)."),
              from: str("First night, YYYY-MM-DD."),
              to: str("Last night, YYYY-MM-DD (the night before check-out)."),
              rackRate: num("Public rate per night for the unit, in rand."),
              minStay: num("Minimum nights, if given."),
              note: str("Anything about how the rate was worked out, or conditions."),
            },
            required: ["from", "to", "rackRate"],
          },
        },
        calendarPrices: {
          type: "array",
          description: "Only for a host/price calendar screenshot that shows a price on individual days: one entry per day.",
          items: {
            type: "object",
            properties: { date: str("YYYY-MM-DD"), amount: num("Price in rand"), booked: { type: "boolean" } },
            required: ["date"],
          },
        },
        missing: {
          type: "array",
          items: { type: "string" },
          description:
            "Short plain-English notes on what an onboarding form needs but these screenshots did NOT show, e.g. 'Only the short amenities list was captured — paste the full amenities page', 'Cancellation policy not shown', 'No unit number shown', 'Fire safety not shown'.",
        },
      },
      required: ["missing"],
    },
  };
}

function normalizeType(t) {
  return String(t || "").split(";")[0].trim().toLowerCase();
}

// images: [{ data: base64 string (no data: prefix), mediaType }]
// pdfs: [{ name, data: base64 }]   (the property's own PDF documents)
// texts: [{ name, text }]          (Word / Excel files, turned into text in the browser)
// Returns { ok: true, fields } or { ok: false, reason, message }.
export async function readListingScreenshots(images, channelHint, amenityOptions, todayIso, pdfs, texts) {
  const usable = (images || []).filter((i) => i && i.data && SUPPORTED.includes(normalizeType(i.mediaType)));
  const pdfList = (pdfs || []).filter((p) => p && p.data).slice(0, 4);
  const textList = (texts || []).filter((t) => t && t.text).slice(0, 8);
  if (!usable.length && !pdfList.length && !textList.length) return { ok: false, reason: "no_images", message: "Nothing readable was sent (use JPG/PNG screenshots, or Word, Excel or PDF files)." };
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return { ok: false, reason: "no_api_key", message: "Screenshot reading isn't switched on yet (ANTHROPIC_API_KEY missing)." };
  }

  const options = (amenityOptions || []).filter((a) => typeof a === "string" && a).slice(0, 400);
  const content = usable.slice(0, 12).map((i) => ({
    type: "image",
    source: { type: "base64", media_type: normalizeType(i.mediaType), data: i.data },
  }));
  pdfList.forEach((p) => {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data }, title: String(p.name || "document.pdf").slice(0, 100) });
  });
  textList.forEach((t) => {
    content.push({ type: "text", text: "Document '" + String(t.name || "file").slice(0, 100) + "':\n" + String(t.text).slice(0, 60000) });
  });
  content.push({
    type: "text",
    text:
      "These are screenshots and/or documents (rate sheets, fact sheets) of one holiday property's own listing" +
      (channelHint ? " on " + channelHint : "") +
      ", taken by the owner or by Avante Travel staff to onboard the property. " +
      "Read every screenshot and fill in the listing form with what is actually shown. " +
      "Combine information across screenshots. Copy text as shown; do not rewrite the description. " +
      "Today's date is " + (todayIso || new Date().toISOString().slice(0, 10)) +
      "; when a date on screen has no year (e.g. '12 Jan - 15 Jan'), use the next future occurrence. " +
      "Ignore pop-ups, cookie or language banners, and anything that belongs to the website rather than the property.",
  });

  const fields = await callClaudeTool([{ role: "user", content }], buildTool(options), 8000);
  if (!fields) {
    return { ok: false, reason: "read_failed", message: "The screenshots couldn't be read just now. Try again, or fill the form in by hand." };
  }
  // Keep only amenities that really are on the form's list.
  if (Array.isArray(fields.amenities)) fields.amenities = fields.amenities.filter((a) => options.includes(a));
  return { ok: true, fields };
}
