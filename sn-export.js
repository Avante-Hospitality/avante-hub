// Builds the Stock Network files for a property onboarding listing, in the
// browser, so they can be downloaded from the onboarding form (step 8) and
// from Admin > Property Listings (with the Site Nr Avante allocated).
//
// Stock Network's API can search and book but cannot CREATE a property, so
// a new property goes to the SN team as files (Jean, 2026-10-13):
//   1. Property file (.xlsx): sheet "Property" (one row, Stock Network's own
//      Resort Information column names where the hub knows them — see
//      netlify/edge-functions/resorts-api.js parseResortsFromCsv), sheet
//      "Unit Types" (unit type, number of units, sleeps), and sheet "Stock"
//      (the rates calendar).
//   2. Rates / stock upload file (.xlsx and .csv): exactly the columns and
//      order of SN's stock upload template (Sheet1, dates as real dates
//      formatted mm-dd-yy like the template Jean supplied).
//
// Needs SheetJS (window.XLSX) for .xlsx; the .csv works without it. SheetJS
// is loaded only when a file is first made (load-script.js): run the export
// inside AvanteSNExport.whenReady(fn), which loads it first (fn runs even if
// it couldn't load, so the .csv still works and the .xlsx gives its message).
// `listing` is the onboarding record shape stored by
// netlify/edge-functions/property-onboarding-api.js (same keys the form
// submits).
(function(){
  var STOCK_COLS = ['Country','Area','District','Resort','Complex','Nr of Units Available','Unit Number','From Date','To Date','Unit Size','Start day of weekend','Weekend Nights','Min Span Weekend','Weekend Rate','Weekend Rack Rate','Start day of midweek','Midweek nights','Min Span Midweek','Midweek Rate','Midweek Rack Rate','Start day of full week','Full week Nights','Min Span Full Week','Full week Rate','Full week Rack Rate','Min Span All nights','All Nights Rate','All Nights Rack Rate'];
  var PROPERTY_COLS = ['Site Nr','SiteID','Resort','Property Type','Complex','Country','State','Area','District','City','City2','Suburb','Address','Latitude','Longitude','Coordinates checked with Google','Telephone','Email','Website','Checkin Time','Checkout Time','Supplier Rating','Tourism Board Rating','WiFi','Parking','Pet Allowance','Allow Same Day Booking','Smoking Allowed','Description','House Rules','Cancellation Policy','Deposit %','Deposit Due (days before arrival)','Child Policy','Accessibility','Owner','Owner Email','Owner Phone','Avante Listing ID','MANUAL Franchisor %','MANUAL Franchise %','Resort Name 2','Resort Booking Link','Rating Link'];
  var UNIT_COLS = ['Site Nr','Resort','Unit Type','Nr of Units','Sleeps (Unit Size)','Max Adults','Children Allowed','Rate Basis','Rate Scheme','Description'];

  function s(v){ return v == null ? '' : String(v).trim(); }
  function has(listing, items){
    var a = listing.amenities || [];
    return a.some(function(x){ return x.available === 'Y' && items.indexOf(x.item) > -1; }) ? 'Y' : 'N';
  }
  function unitFor(listing, name){
    var u = (listing.unitTypes || []).filter(function(x){ return s(x.name) === s(name); })[0];
    return u || (listing.unitTypes || [])[0] || {};
  }
  // Excel date serial (days since 1899-12-30), worked out in UTC so the
  // browser's time zone can't push a date to the day before or add hours.
  function toSerial(iso){ var p = s(iso).split('-'); return p.length === 3 ? (Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 864e5 : ''; }

  // Days of the week for weekend rates and closed nights (Jean, 2026-10-22):
  // 0 = Monday ... 6 = Sunday, the night guests sleep there. The form cuts
  // the rates into midweek and weekend periods; each is a plain row here.
  var DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  function dayOf(iso){ var p = s(iso).split('-'); return (new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() + 6) % 7; }
  function dayList(v){
    var out = [];
    (Array.isArray(v) ? v : s(v).split(',')).forEach(function(x){ var n = parseInt(x, 10); if(n >= 0 && n <= 6 && out.indexOf(n) < 0) out.push(n); });
    return out.sort();
  }
  // The days as one run in a row round the week ({ start, nights }), or null.
  // [4,5] -> Fri, 2 nights; [6,0] -> Sun, 2 nights; [1,3] -> null.
  function dayRun(days){
    days = dayList(days);
    if(!days.length || days.length === 7) return days.length ? { start: 0, nights: 7 } : null;
    var start = days.filter(function(d){ return days.indexOf((d + 6) % 7) < 0; });
    if(start.length !== 1) return null;
    return { start: start[0], nights: days.length };
  }
  // "Weekend · Closed Mon" — what admin shows next to a period.
  function weekText(r){
    var c = dayList(r.closedDays);
    return [s(r.slot), c.length ? 'Closed ' + c.map(function(d){ return DAY_NAMES[d].slice(0, 3); }).join(', ') : ''].filter(Boolean).join(' · ');
  }

  function todayIso(){ var d = new Date(), p = function(n){ return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function seasonKey(r){ return [s(r.unitTypeName), s(r.from), s(r.to), s(r.rackRate), s(r.minStay), s(r.slot)].join('|'); }
  // Seasons Stock Network needs: today onwards only (past rates stay on
  // record in the hub but are never re-sent). With onlyChanged, seasons
  // already sent to SN unchanged (listing.snSentSeasons, set by admin's
  // "Mark rates as sent to SN") are left out.
  function seasonsToSend(listing, onlyChanged){
    var today = todayIso();
    var sent = {}; (listing.snSentSeasons || []).forEach(function(r){ sent[seasonKey(r)] = true; });
    return (listing.rateSeasons || []).filter(function(r){ return s(r.to) >= today && !(onlyChanged && sent[seasonKey(r)]); })
      .map(function(r){ return s(r.from) < today ? Object.assign({}, r, { from: today }) : r; });
  }
  // One row per rate season (and unit type), in SN's stock upload layout.
  function stockRows(listing, onlyChanged){
    return seasonsToSend(listing, onlyChanged).map(function(r){
      var u = unitFor(listing, r.unitTypeName);
      var row = []; for(var i = 0; i < 28; i++) row.push('');
      row[0] = s(listing.country); row[1] = s(listing.area); row[2] = s(listing.district) || s(listing.suburb);
      row[3] = s(listing.propertyName); row[4] = s(r.unitTypeName); row[5] = +s(u.numUnits) || 1; row[6] = s(r.unitTypeName);
      row[7] = r.from; row[8] = r.to; row[9] = +s(u.maxOccupancy) || '';
      row[25] = +r.minStay || 1; row[26] = +r.snRate || ''; row[27] = +r.rackRate || '';
      return row;
    });
  }
  function propertyRow(listing, siteNr){
    var C = window.AvanteCommission, own = !!C && C.ownBookings(listing);
    return [
      s(siteNr || listing.siteNr), s(listing.siteId), s(listing.propertyName), s(listing.propertyType), s(listing.complexName),
      s(listing.country), s(listing.stateProvince), s(listing.area), s(listing.district), s(listing.city), s(listing.city2), s(listing.suburb),
      s(listing.streetAddress), s(listing.latitude), s(listing.longitude), listing.coordsVerified === 'Y' ? 'Y' : 'N',
      s(listing.telephone), s(listing.email), s(listing.infoLink), s(listing.checkInTime), s(listing.checkOutTime),
      s(listing.selfSupplierRating), s(listing.tourismBoardGrading),
      has(listing, ['Wi-Fi','Free Wi-Fi']), has(listing, ['Free parking','Paid parking','Secure/gated parking']),
      has(listing, ['Pets allowed']), listing.allowSameDayBooking === 'Y' ? 'Y' : 'N', 'N',
      s(listing.description), s(listing.houseRules), s(listing.depositPolicyText), s(listing.depositPct), s(listing.depositDays),
      s(listing.childPolicy), s(listing.accessibility), s(listing.ownerFullName), s(listing.ownerEmail), s(listing.ownerPhone), s(listing.listingId),
      // Stock Network's split on the property's own bookings (commission.js).
      own ? C.FRANCHISOR : '', own ? C.FRANCHISE : '',
      // Fields on Stock Network's resort screen the listing already has (Jean, 2026-10-22).
      s(listing.propertyName2), s(listing.bookingLink), s(listing.ratingLink)
    ];
  }
  function unitRowsFor(listing, siteNr){
    return (listing.unitTypes || []).filter(function(u){ return s(u.name) || s(u.maxOccupancy); }).map(function(u){
      return [s(siteNr || listing.siteNr), s(listing.propertyName), s(u.name), +s(u.numUnits) || 1, +s(u.maxOccupancy) || '', +s(u.maxAdults) || '', u.childrenAllowed === 'N' ? 'N' : 'Y', s(u.rateBasis), s(u.rateScheme), s(u.description)];
    });
  }

  function sheetWithDates(header, rows, dateCols){
    var XLSX = window.XLSX;
    var data = [header].concat(rows.map(function(r){ return r.map(function(v, i){ return dateCols.indexOf(i) > -1 ? toSerial(v) : v; }); }));
    var ws = XLSX.utils.aoa_to_sheet(data);
    // Same look as SN's template: dates shown mm-dd-yy.
    for(var r = 1; r < data.length; r++) dateCols.forEach(function(c){ var ref = XLSX.utils.encode_cell({ r: r, c: c }); if(ws[ref]) ws[ref].z = 'mm-dd-yy'; });
    ws['!cols'] = header.map(function(h){ return { wch: Math.max(10, Math.min(40, h.length + 2)) }; });
    return ws;
  }
  function fileSafe(name){ return s(name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'property'; }
  // Jean (2026-10-13): Avante allocates the SN Site Nr once the basic info
  // is in; only then can the files be downloaded for Stock Network (manual
  // upload or SN's import). The Site ID (= affiliate number) and the SN API
  // credentials only come from Stock Network AFTER the site is set up, so
  // the files don't need them (the Site ID column stays empty until then).
  function needSite(listing, siteNr){
    if(!s(siteNr || listing.siteNr)) throw new Error('Allocate the StockNetwork Site Nr first — the Stock Network files need it.');
  }
  function needXlsx(){ if(!window.XLSX) throw new Error('The spreadsheet tool did not load. Check your internet and reload the page.'); }

  function propertyWorkbook(listing, siteNr){
    needXlsx();
    var XLSX = window.XLSX, wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([PROPERTY_COLS, propertyRow(listing, siteNr)]), 'Property');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([UNIT_COLS].concat(unitRowsFor(listing, siteNr))), 'Unit Types');
    XLSX.utils.book_append_sheet(wb, sheetWithDates(STOCK_COLS, stockRows(listing), [7, 8]), 'Stock');
    // Every rate season on record, past ones included, for reference.
    var today = todayIso(), sent = {}; (listing.snSentSeasons || []).forEach(function(r){ sent[seasonKey(r)] = true; });
    var hist = (listing.rateSeasons || []).map(function(r){ return [s(r.unitTypeName), r.from, r.to, +r.nights || '', +r.minStay || '', +r.rackRate || '', +r.snRate || '', weekText(r), s(r.to) < today ? 'Past' : (sent[seasonKey(r)] ? 'Sent to SN' : 'Not sent yet')]; });
    XLSX.utils.book_append_sheet(wb, sheetWithDates(['Unit Type','From','To','Nights','Min Stay','Rack Rate','SN Rate','Slot / closed','Status'], hist, [1, 2]), 'All rates on record');
    return wb;
  }
  function stockWorkbook(listing, onlyChanged){
    needXlsx();
    var XLSX = window.XLSX, wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetWithDates(STOCK_COLS, stockRows(listing, onlyChanged), [7, 8]), 'Sheet1');
    return wb;
  }
  function csvCell(v){ v = s(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function stockCsv(listing, onlyChanged){
    return [STOCK_COLS].concat(stockRows(listing, onlyChanged)).map(function(r){ return r.map(csvCell).join(','); }).join('\r\n');
  }
  function download(name, blob){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function b64Utf8(text){
    var bytes = new TextEncoder().encode(text), bin = '';
    for(var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function names(listing, nr){
    var site = nr ? 'site' + nr + '_' : '', p = fileSafe(listing.propertyName);
    return {
      property: 'SN_new_property_' + site + p + '.xlsx',
      stock: function(only, ext){ return 'SN_stock_rates_' + (only ? 'new_' : '') + site + p + '.' + ext; }
    };
  }
  // Jean (2026-10-13): the same files, ready to attach to an email from
  // Admin (base64). opts: { property: bool, rates: 'all'|'new'|'', format: 'xlsx'|'csv'|'both' }
  function filesForEmail(listing, siteNr, opts){
    needSite(listing, siteNr);
    var nr = s(siteNr || listing.siteNr), n = names(listing, nr), out = [];
    var fmt = opts.format || 'xlsx';
    if(opts.property){ needXlsx(); out.push({ filename: n.property, content: window.XLSX.write(propertyWorkbook(listing, nr), { type: 'base64', bookType: 'xlsx' }) }); }
    if(opts.rates){
      var only = opts.rates === 'new';
      if(!seasonsToSend(listing, only).length) throw new Error(only ? 'No new or changed future rates since they were last marked as sent.' : 'This listing has no future rates set.');
      if(fmt === 'xlsx' || fmt === 'both'){ needXlsx(); out.push({ filename: n.stock(only, 'xlsx'), content: window.XLSX.write(stockWorkbook(listing, only), { type: 'base64', bookType: 'xlsx' }) }); }
      if(fmt === 'csv' || fmt === 'both') out.push({ filename: n.stock(only, 'csv'), content: b64Utf8('\ufeff' + stockCsv(listing, only)) });
    }
    if(!out.length) throw new Error('Tick at least one file to send.');
    return out;
  }

  // Loads SheetJS (if it isn't yet), then runs fn; resolves with fn's result
  // and rejects with what fn throws.
  function whenReady(fn){
    var loading = window.XLSX || !window.AvanteScripts ? Promise.resolve() : window.AvanteScripts.xlsx().catch(function(){});
    return loading.then(function(){ return fn(); });
  }

  window.AvanteSNExport = {
    whenReady: whenReady,
    filesForEmail: filesForEmail,
    STOCK_COLS: STOCK_COLS,
    DAY_NAMES: DAY_NAMES,
    dayOf: dayOf,
    dayList: dayList,
    dayRun: dayRun,
    weekText: weekText,
    stockRows: stockRows,
    needSite: needSite,
    downloadPropertyFile: function(listing, siteNr){
      needSite(listing, siteNr);
      var nr = s(siteNr || listing.siteNr);
      window.XLSX && window.XLSX.writeFile(propertyWorkbook(listing, nr), 'SN_new_property_' + (nr ? 'site' + nr + '_' : '') + fileSafe(listing.propertyName) + '.xlsx');
      if(!window.XLSX) needXlsx();
    },
    countToSend: function(listing, onlyChanged){ return seasonsToSend(listing, onlyChanged).length; },
    downloadStockXlsx: function(listing, siteNr, onlyChanged){
      needSite(listing, siteNr);
      var nr = s(siteNr || listing.siteNr);
      window.XLSX && window.XLSX.writeFile(stockWorkbook(listing, onlyChanged), 'SN_stock_rates_' + (onlyChanged ? 'new_' : '') + (nr ? 'site' + nr + '_' : '') + fileSafe(listing.propertyName) + '.xlsx');
      if(!window.XLSX) needXlsx();
    },
    downloadStockCsv: function(listing, siteNr, onlyChanged){
      needSite(listing, siteNr);
      var nr = s(siteNr || listing.siteNr);
      download('SN_stock_rates_' + (onlyChanged ? 'new_' : '') + (nr ? 'site' + nr + '_' : '') + fileSafe(listing.propertyName) + '.csv', new Blob(['\ufeff' + stockCsv(listing, onlyChanged)], { type: 'text/csv;charset=utf-8' }));
    }
  };
})();
