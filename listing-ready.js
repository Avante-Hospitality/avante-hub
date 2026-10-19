// The listing's Ready check (Jean, 2026-10-19): one list of rules for the
// listing form (property-form.html shows it) and the server (completeListing
// gives a Site Nr only when it is all Done). A plain script: in the browser it
// sets window.ListingReady; the edge function imports it for globalThis.ListingReady.
//
// ListingReady.checks(rec) -> [[done, label, step], ...]
//   rec: the listing as saved (property-form.html buildPayload / the stored record),
//   plus: treePlaced (placed in the hub location tree), editing (an existing listing).
(function (root) {
  function has(v) { return String(v == null ? '' : v).trim() !== ''; }
  function unitName(u, i) { return String((u && u.name) || '').trim() || ('Unit Type ' + (i + 1)); }
  function docOf(rec, type) { return (rec.documents || []).some(function (d) { return d && d.type === type; }); }

  function checks(rec) {
    var units = rec.unitTypes || [], images = rec.images || [], seasons = rec.rateSeasons || [];
    var amen = (rec.amenities || []).filter(function (a) { return a && a.available === 'Y'; }).length;
    var propPhotos = images.filter(function (im) { return im && im.type !== 'Unit'; }).length;
    var fromChannel = rec.ratesFromChannel === 'Y', onSN = rec.existingOnSN === 'Y';
    return [
      [has(rec.propertyName), 'Property name', 4],
      [has(rec.ownerFullName) && has(rec.ownerIdPassport), 'Owner name and ID number', 2],
      [has(rec.latitude) && has(rec.longitude), 'Coordinates filled in', 3],
      [rec.coordsVerified === 'Y', 'Coordinates checked with Google', 3],
      [!!rec.treePlaced || (has(rec.suburb) && has(rec.city) && !!rec.editing), 'Placed in the hub location tree', 3],
      [units.some(function (u) { return has(u.name) && has(u.maxOccupancy); }), 'Unit type name and sleeps', 5],
      [amen > 0, 'Amenities ticked (' + amen + ')', 5],
      [fromChannel || seasons.length > 0, fromChannel ? 'Rates come from your channel manager' : 'Rates set on the calendar (' + seasons.length + ' season' + (seasons.length === 1 ? '' : 's') + ')', 6],
      [propPhotos > 0, 'Property photos (' + propPhotos + ')', 7],
      [units.length > 0 && units.every(function (u, i) { var n = unitName(u, i); return images.some(function (im) { return im && im.type === 'Unit' && im.unitTypeName === n; }); }), 'Photos of every unit type', 5],
      [onSN || (docOf(rec, 'id-document') && docOf(rec, 'proof-of-ownership') && docOf(rec, 'proof-of-residence')), onSN ? 'Documents (done when you joined Avante)' : 'ID, proof of ownership and proof of residence', 7],
      [rec.submittedBy !== 'Affiliate' || docOf(rec, 'mandate'), 'Signed mandate (affiliates only)', 7],
      [has(rec.depositPolicyText), 'Cancellation policy', 8]
    ];
  }
  function todo(rec) { return checks(rec).filter(function (c) { return !c[0]; }).map(function (c) { return c[1]; }); }
  root.ListingReady = { checks: checks, todo: todo };
})(typeof window !== 'undefined' ? window : globalThis);
