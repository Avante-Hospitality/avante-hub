// Avante's commission (Jean, 2026-10-22): one place for every rate the hub
// shows, stores or sends to Stock Network. A plain script: in the browser it
// sets window.AvanteCommission; edge functions import it for
// globalThis.AvanteCommission (like listing-ready.js).
//
// Every property listed with Avante gives Avante 15% + VAT. Rates go onto
// Stock Network at the net rate (rack less 17.25%), with the rack shown too.
// On the property's OWN bookings (made through the hub with its own hook
// builder and/or front store) Avante keeps 5% + VAT; Stock Network splits the
// 17.25% with two fields on the property's site:
//   Franchisor (Avante)              5% + VAT = 5.75%
//   Franchise  (the property affiliate) 10% + VAT = 11.5%
// Avante's commission includes the card transaction fees (credit and debit
// cards, Apple Pay, Google Pay). The property only ever sees the 5% + VAT.
(function (root) {
  var VAT = 15;                // %
  var STANDARD = 15;           // % excl. VAT, bookings from every Avante platform
  var OWN = 5;                 // % excl. VAT, the property's own bookings
  function withVat(p) { return Math.round(p * (1 + VAT / 100) * 100) / 100; }
  root.AvanteCommission = {
    VAT: VAT,
    STANDARD: STANDARD,
    OWN: OWN,
    STANDARD_INCL: withVat(STANDARD),            // 17.25: the rate on Stock Network's set-up sheet
    FRANCHISOR: withVat(OWN),                    // 5.75: Avante's share on own bookings
    FRANCHISE: withVat(STANDARD - OWN),          // 11.5: the property affiliate's share
    withVat: withVat,
    // The net (Avante) rate for a rack rate, rounded to the rand.
    netRate: function (rack) { return Math.round(rack * (1 - withVat(STANDARD) / 100)); },
    // What the property is shown.
    ownText: OWN + '% + VAT',
    // A listing that sells itself through the hub (own hook builder and/or
    // front store): a channel property affiliate, or a property not on a
    // channel manager (always a property affiliate). Its Stock Network site
    // gets the Franchisor / Franchise fields.
    ownBookings: function (listing) { return !!listing && (listing.channelProperty === 'Y' || listing.ratesFromChannel !== 'Y'); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
