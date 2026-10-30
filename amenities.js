// Amenities (Jean, 2026-10-30): one place for the amenity list the Avante
// listing ticks (property-form.html), for how the front store groups it
// (stay.html and lib/stay-payload.js through pa-core.js), and for the little
// picture shown next to an amenity or highlight. A plain script: in the
// browser it sets window.AvanteAmenities; edge functions import it for
// globalThis.AvanteAmenities (like commission.js).
(function (root) {
  var DATA = {
    "In-Unit / Room Amenities": ["Air-conditioning", "Heating", "Ceiling fans", "TV", "DSTV/Satellite TV", "Smart TV / Streaming (Netflix etc.)", "Wi-Fi", "Coffee/tea station", "Bar fridge", "Kitchenette", "Full kitchen in unit", "Dishwasher", "Microwave", "Hairdryer", "Iron & ironing board", "Study/work desk", "Mosquito nets", "Blackout curtains", "Private balcony/patio", "Sea view", "Mountain view", "En-suite bathroom", "Bath", "Shower", "Toiletries provided", "Bathrobes", "Extra-length/queen/king bed", "Cot/crib available", "Safe in room"],
    "Establishment / Property Facilities": ["Free Wi-Fi", "Free parking", "Paid parking", "Secure/gated parking", "Backup power (generator/inverter)", "Backup water supply", "Borehole water", "Swimming pool", "Private pool", "Shared/communal pool", "Jacuzzi/hot tub", "Braai/BBQ facilities", "Garden", "Patio/veranda", "Fireplace/boma", "Elevator/lift", "Laundry facilities/service", "Housekeeping/cleaning service", "Reception/24hr check-in", "Concierge service", "Room service", "Restaurant on-site", "Bar on-site", "Conference/meeting facilities", "Wedding/function venue"],
    "Kitchen & Dining": ["Full kitchen", "Fridge/freezer", "Stove & oven", "Microwave", "Dishwasher", "Kettle", "Toaster", "Coffee machine", "Wine cooler", "Braai/outdoor cooking area", "Outdoor dining area", "Complimentary welcome pack", "Breakfast included", "Private chef available on request"],
    "Outdoor & Recreation": ["Swimming pool", "Private plunge pool", "Beach access", "Direct beach frontage", "Sea view", "Mountain view", "Hiking trails on property", "Fishing access", "Boat launch/jetty", "Bicycles available", "Tennis court", "Golf course access", "Games room", "Kids' play area", "Trampoline"],
    "Safety & Security": ["Smoke detectors", "Fire extinguisher", "First aid kit", "CCTV cameras", "Alarm system", "Electric fencing", "24-hour security/patrol", "Guarded/gated estate", "Safe/lockbox", "Pool safety fence/net", "Child safety gates", "Carbon monoxide detector"],
    "Accessibility": ["Wheelchair-accessible entrance", "Step-free access throughout", "Accessible bathroom/roll-in shower", "Wide doorways", "Elevator/lift", "Ground-floor unit available", "Accessible parking bay"],
    "Family & Pets": ["Cot/crib available", "High chair", "Kid-friendly furnishings", "Baby-proofed", "Babysitting service on request", "Pets allowed", "Pet-free property", "Pet amenities provided (bowls/bed)"],
    "Activities & Experiences": ["Whale watching", "Scuba diving/snorkeling", "Surfing lessons", "Hiking/nature trails", "Golf", "Fishing charters", "Wine tasting tours", "Game drives/safari", "Horse riding", "Canopy tours/zipline", "Kayaking/canoeing", "Boat cruises/sunset cruises", "Spa & wellness treatments", "Cultural/heritage tours", "Local craft markets", "Cooking classes", "Cycling routes", "Bird watching", "4x4/off-road trails", "Stargazing"]
  };
  // What a guest finds inside a unit (each unit can tick its own on the listing).
  var UNIT_CATS = ["In-Unit / Room Amenities", "Kitchen & Dining"];
  // What the complex or resort has, as the front store's "On the resort" groups.
  // Activities & Experiences stay out: the front store has Things to do nearby.
  var RESORT_GROUPS = [
    { title: "Facilities", cats: ["Establishment / Property Facilities"] },
    { title: "Outdoors", cats: ["Outdoor & Recreation"] },
    { title: "Families & pets", cats: ["Family & Pets"] },
    { title: "Safety & security", cats: ["Safety & Security"] },
    { title: "Accessibility", cats: ["Accessibility"] }
  ];
  function unique(list) { var out = []; for (var i = 0; i < list.length; i++) if (list[i] && out.indexOf(list[i]) < 0) out.push(list[i]); return out; }
  function itemsOf(cats) { var out = []; for (var i = 0; i < cats.length; i++) out = out.concat(DATA[cats[i]] || []); return unique(out); }
  // The ticked items of a listing (amenities: [{category, item, available}]) in these categories.
  function tickedIn(amenities, cats) {
    var out = [];
    for (var i = 0; i < (amenities || []).length; i++) { var a = amenities[i]; if (a && a.available === "Y" && cats.indexOf(a.category) > -1) out.push(a.item); }
    return unique(out);
  }
  // The front store's "On the resort" groups from a listing; an item shows once.
  function resortGroups(amenities) {
    var seen = [], out = [];
    for (var i = 0; i < RESORT_GROUPS.length; i++) {
      var items = tickedIn(amenities, RESORT_GROUPS[i].cats).filter(function (x) { return seen.indexOf(x) < 0; });
      seen = seen.concat(items);
      if (items.length) out.push({ title: RESORT_GROUPS[i].title, items: items });
    }
    return out;
  }
  // A little picture for an amenity or highlight, from its words.
  var ICONS = [[/pool|swim/i, "🏊"], [/beach|sand|sea\b|ocean/i, "🏖️"], [/view/i, "🌅"], [/wi-?fi|internet/i, "📶"], [/braai|bbq|barbecue|outdoor cooking/i, "🔥"], [/fire ?place|boma/i, "🪵"],
    [/sleep|bed|cot|crib/i, "🛏️"], [/park/i, "🚗"], [/pet|dog/i, "🐾"], [/garden|green|forest|nature/i, "🌿"], [/golf/i, "⛳"], [/kid|child|play|trampoline|high chair|baby/i, "🧸"],
    [/air ?con|aircon|fan/i, "❄️"], [/heating/i, "♨️"], [/kitchen|stove|oven|microwave|toaster|kettle|fridge|freezer|coffee|tea|dishwasher|chef|dining|breakfast/i, "🍳"], [/river|lagoon|lake|fishing|boat|jetty/i, "🛶"],
    [/secur|cctv|alarm|fenc|guard|safe\b|safe\/|lockbox/i, "🔒"], [/smoke|fire extinguisher|carbon|first aid/i, "🧯"], [/dstv|tv\b|tv |streaming|netflix/i, "📺"], [/bath|shower|toiletries|robe|en-suite/i, "🛁"],
    [/hairdryer|iron/i, "👕"], [/laundry|housekeeping|cleaning/i, "🧺"], [/wheelchair|accessible|step-free|doorway|ground-floor|elevator|lift/i, "♿"], [/power|generator|inverter/i, "🔋"], [/water/i, "💧"],
    [/jacuzzi|hot tub|spa\b/i, "🛀"], [/restaurant|bar\b|bar on|wine/i, "🍷"], [/reception|concierge|check-in|room service/i, "🛎️"], [/desk|conference|meeting/i, "💼"], [/wedding|function/i, "💐"],
    [/patio|veranda|balcony/i, "🪑"], [/tennis|games|bicycle|hiking|trail/i, "🎾"], [/mosquito|blackout|curtain/i, "🌙"]];
  function icon(t) { for (var i = 0; i < ICONS.length; i++) if (ICONS[i][0].test(t)) return ICONS[i][1]; return "✓"; }
  // The front store's unit cards and amenity sections (Jean, 2026-10-30), from
  // the store's own choices (page: units[{name, photos}], showAmenities) and the
  // property's Avante listing (listing: {units: {name: {photos, description,
  // amenities}}, inUnit, resort}), the master for amenities:
  // - photos: the ones chosen in the builder, then the listing's photos of that unit;
  // - amenities: when any unit type ticks its own, every card shows its list (else
  //   the property's In-Unit list); otherwise "In your unit" shows once for all;
  // - resort: the "On the resort" groups.
  // Used by the page data (lib/stay-payload.js) and the builder's preview.
  var UNIT_PHOTOS = 12;
  function frontUnits(page, listing) {
    var L = listing || {}, lu = L.units || {}, inUnit = L.inUnit || [], on = page.showAmenities !== false;
    var own = function (u) { return (lu[u.name] || {}).amenities || []; };
    var perUnit = on && (page.units || []).some(function (u) { return own(u).length; });
    var units = (page.units || []).map(function (u) {
      var li = lu[u.name] || {}, out = {};
      for (var k in u) out[k] = u[k];
      out.photos = unique((u.photos || []).concat(li.photos || [])).slice(0, UNIT_PHOTOS);
      out.details = li.description || "";
      out.amenities = perUnit ? (own(u).length ? own(u) : inUnit) : [];
      return out;
    });
    return { units: units, amenities: on ? { inUnit: perUnit ? [] : inUnit, resort: L.resort || [] } : { inUnit: [], resort: [] } };
  }
  root.AvanteAmenities = { frontUnits: frontUnits, UNIT_PHOTOS: UNIT_PHOTOS, DATA: DATA, UNIT_CATS: UNIT_CATS, RESORT_GROUPS: RESORT_GROUPS, UNIT_ITEMS: itemsOf(UNIT_CATS), unique: unique, tickedIn: tickedIn, resortGroups: resortGroups, icon: icon };
})(typeof window !== "undefined" ? window : globalThis);
