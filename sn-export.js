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
  var PROPERTY_COLS = ['Site Nr','SiteID','Resort','Property Type','Complex','Country','State','Area','District','City','City2','Suburb','Address','Latitude','Longitude','Coordinates checked with Google','Telephone','Email','Website','Checkin Time','Checkout Time','Supplier Rating','Tourism Board Rating','WiFi','Parking','Pet Allowance','Allow Same Day Booking','Smoking Allowed','Description','House Rules','Cancellation Policy','Deposit %','Deposit Due (days before arrival)','Child Policy','Accessibility','Owner','Owner Email','Owner Phone','Avante Listing ID','MANUAL Franchisor %','MANUAL Franchise %','Resort Name 2','Resort Booking Link','Rating Link','Amenities','Activities','Experiences','Account Name','Bank','Account Type','Account Nr','Branch Number'];
  var UNIT_COLS = ['Site Nr','Resort','Unit Type','Nr of Units','Sleeps (Unit Size)','Max Adults','Children Allowed','Rate Basis','Rate Scheme','Description'];

  function s(v){ return v == null ? '' : String(v).trim(); }
  function has(listing, items){
    var a = listing.amenities || [];
    return a.some(function(x){ return x.available === 'Y' && items.indexOf(x.item) > -1; }) ? 'Y' : 'N';
  }
  // "golf;  hiking,Whale watching" -> "golf, hiking, Whale watching"
  function commaList(v){ return s(v).split(/\s*[,;\n]+\s*/).filter(Boolean).join(', '); }
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

  // A night's price on a day: { closed, weekend, price, min } (null without a rate).
  // r: { rack, min } plus, with a weekly pattern, wr / wm (weekend rack rate and
  // min stay), wd (weekend nights "4,5") and cd (closed nights "0").
  function nightInfo(r, k){
    if(!r) return null;
    var d = dayOf(k), closed = !!r.cd && dayList(r.cd).indexOf(d) > -1, we = !closed && !!r.wr && dayList(r.wd).indexOf(d) > -1;
    return { closed: closed, weekend: we, price: we ? r.wr : r.rack, min: we ? (r.wm || r.min) : r.min };
  }
  function nextDay(iso){ var p = s(iso).split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 1)); return d.toISOString().slice(0, 10); }
  function eachNight(from, to, fn){ for(var k = from; k <= to; k = nextDay(k)) fn(k); }
  // The night a saved period stands for (the form's calendar shape).
  function nightOf(rs){
    if(TIMESHARE_SLOTS.indexOf(s(rs.slot)) > -1 && s(rs.timeshare)) return tsNight(rs.timeshare, s(rs.from), s(rs.slot), +rs.rackRate, +rs.minStay || 1, +rs.slotPrice || 0);
    var wr = +rs.weekendRackRate || 0;
    return { rack: +(wr ? rs.midweekRackRate || rs.rackRate : rs.rackRate), min: +(wr ? rs.midweekMinStay || rs.minStay : rs.minStay) || 1, wr: wr,
      wm: wr ? (+rs.weekendMinStay || +rs.minStay || 1) : 0, wd: wr ? dayList(rs.weekendDays).join(',') : '', cd: dayList(rs.closedDays).join(',') };
  }
  function nightKey(n){ return [n.rack, n.min, n.wr, n.wm, n.wd, n.cd, n.blk || ''].join('|'); }

  // Timeshare (Jean, 2026-10-27): dates sold only in fixed slots. "week" =
  // whole weeks from a changeover day; "split" = a midweek slot and a weekend
  // slot that can be sold separately (to the same guest or different guests).
  // Every slot is its own Stock Network row, even next to a slot with the same
  // price, and its minimum stay is the whole slot, so nobody buys part of one.
  // The price typed is for the whole slot; Stock Network gets it per night.
  var TIMESHARE_SLOTS = ['Week', 'Midweek', 'Weekend'];
  function tsNight(kind, slotStart, label, rack, nights, slotPrice){
    return { rack: rack, min: nights, wr: 0, wm: 0, wd: '', cd: '', ts: kind, blk: slotStart, tsl: label, tsp: slotPrice };
  }
  // The slots in first..last night, or { error }. kind "week": opts.change =
  // changeover day; "split": opts.midweek and opts.weekend = the days each
  // slot starts (0 = Monday ... 6 = Sunday). The dates must be whole slots.
  function timeshareSlots(first, last, kind, opts){
    var starts = kind === 'week' ? [{ day: +opts.change, label: 'Week' }]
      : [{ day: +opts.midweek, label: 'Midweek' }, { day: +opts.weekend, label: 'Weekend' }];
    if(kind === 'split' && starts[0].day === starts[1].day) return { error: 'Midweek and weekend can\'t start on the same day.' };
    var startOf = function(k){ var d = dayOf(k); for(var i = 0; i < starts.length; i++) if(starts[i].day === d) return starts[i]; return null; };
    var names = starts.map(function(x){ return DAY_NAMES[x.day]; }).join(' or ');
    if(!startOf(first)) return { error: 'Start on a ' + names + ': that is when a ' + (kind === 'week' ? 'week' : 'slot') + ' begins.' };
    if(!startOf(nextDay(last))) return { error: 'End on the night before a ' + names + ', so the last ' + (kind === 'week' ? 'week' : 'slot') + ' is whole.' };
    var out = [], cur = null;
    eachNight(first, last, function(k){
      var st = startOf(k);
      if(st){ if(cur) out.push(cur); cur = { from: k, to: k, nights: 1, label: st.label }; }
      else { cur.to = k; cur.nights++; }
    });
    if(cur) out.push(cur);
    return { slots: out };
  }

  // Saved periods -> { unit type: { 'YYYY-MM-DD': night } }.
  // Nights booked on another channel (listing.blockedNights) stay OPEN on
  // Avante (Jean, 2026-10-25): the property is set up with everything
  // available, and once its channel calendars are linked (iCal) only their
  // bookings close nights. Listings saved before this left those nights out
  // of their periods; a gap of booked nights between two periods with the
  // same rates gets those rates back.
  function ratesFromSeasons(seasons, blockedNights){
    var booked = {}; (blockedNights || []).forEach(function(k){ booked[k] = true; });
    var byUnit = {};
    (seasons || []).forEach(function(rs){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(s(rs.from)) || !/^\d{4}-\d{2}-\d{2}$/.test(s(rs.to))) return;
      (byUnit[s(rs.unitTypeName)] = byUnit[s(rs.unitTypeName)] || []).push(rs);
    });
    var out = {};
    Object.keys(byUnit).forEach(function(unit){
      var list = byUnit[unit].sort(function(a, b){ return s(a.from) < s(b.from) ? -1 : 1; }), R = out[unit] = {};
      list.forEach(function(rs, i){
        var n = nightOf(rs);
        eachNight(s(rs.from), s(rs.to), function(k){ R[k] = Object.assign({}, n); });
        var next = list[i + 1];
        if(!next || nightKey(nightOf(next)) !== nightKey(n)) return;
        var gap = [], allBooked = true;
        for(var k = nextDay(s(rs.to)); k < s(next.from); k = nextDay(k)){ gap.push(k); if(!booked[k] && !nightInfo(n, k).closed) allBooked = false; }
        if(gap.length && allBooked) gap.forEach(function(k){ R[k] = Object.assign({}, n); });
      });
    });
    return out;
  }
  // One unit's nights -> its rate periods (one Stock Network row each).
  // Jean, 2026-10-22: with a weekend rate, the run is cut at every change
  // between midweek and weekend nights, so each midweek slot and each
  // weekend slot is its own period with its own rate and minimum stay.
  // Without one, a run of nights with the same rate is one period. Closed
  // nights are never in a period; nights booked elsewhere are (see above).
  function periodsOf(R, unitTypeName){
    var keys = Object.keys(R || {}).sort(), out = [], cur = null;
    if(!keys.length) return out;
    eachNight(keys[0], keys[keys.length - 1], function(k){
      var r = R[k], ni = nightInfo(r, k), ok = r && !ni.closed;
      var slot = ok && r.ts ? r.tsl : ok && r.wr && dayList(r.wd).length ? (ni.weekend ? 'Weekend' : 'Midweek') : '';
      var key = ok ? [ni.price, ni.min, slot, r.rack, r.min, r.wr || 0, r.wm || 0, r.wd || '', r.cd || '', r.blk || ''].join('|') : '';
      if(ok && cur && cur.key === key){ cur.to = k; cur.nights++; }
      else { if(cur) out.push(cur); cur = ok ? { key: key, unitTypeName: unitTypeName, from: k, to: k, nights: 1, rack: ni.price, min: ni.min, slot: slot, r: r } : null; }
    });
    if(cur) out.push(cur);
    return out;
  }
  // A period as it is saved on the listing and sent to Stock Network.
  function seasonOut(p){
    var r = p.r, o = { unitTypeName: p.unitTypeName, from: p.from, to: p.to, nights: p.nights, minStay: p.min, rackRate: p.rack, snRate: window.AvanteCommission.netRate(p.rack), slot: p.slot, closedDays: r.cd || '' };
    if(r.ts) Object.assign(o, { timeshare: r.ts, slotPrice: r.tsp || p.rack * p.nights });
    else if(p.slot) Object.assign(o, { midweekRackRate: r.rack, midweekMinStay: r.min, weekendRackRate: r.wr, weekendMinStay: r.wm || r.min, weekendDays: r.wd });
    return o;
  }
  // The listing's periods with every night open (booked nights included).
  function openSeasons(listing){
    var R = ratesFromSeasons(listing.rateSeasons, listing.blockedNights), out = [];
    Object.keys(R).forEach(function(unit){ out = out.concat(periodsOf(R[unit], unit).map(seasonOut)); });
    return out;
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
    // A timeshare slot that has already begun can't be sold any more (only whole slots are).
    return openSeasons(listing).filter(function(r){ return s(r.to) >= today && !(r.timeshare && s(r.from) < today) && !(onlyChanged && sent[seasonKey(r)]); })
      .map(function(r){ return s(r.from) < today ? Object.assign({}, r, { from: today }) : r; });
  }
  // Stock Network's To Date is the day the guest LEAVES, not the last night
  // (Jean, 2026-10-25: the last night of every period came through closed on
  // SN, e.g. Thu 29 Oct after 25-29 Oct midweek). A period's `to` is its last
  // night, so the file gives the day after.
  function snToDate(lastNight){ return nextDay(lastNight); }
  // One row per rate season (and unit type), in SN's stock upload layout.
  // Country, Area, District and Resort are how Stock Network names the
  // property now (listing.snNames, from the hub's Stock Network list), since
  // it matches the rows on them; the hub's own names until it has a row.
  function stockRows(listing, onlyChanged){
    var sn = listing.snNames || {};
    return seasonsToSend(listing, onlyChanged).map(function(r){
      var u = unitFor(listing, r.unitTypeName);
      var row = []; for(var i = 0; i < 28; i++) row.push('');
      row[0] = s(sn.country) || s(listing.country); row[1] = s(sn.area) || s(listing.area); row[2] = s(sn.district) || s(listing.district) || s(listing.suburb);
      row[3] = s(sn.resort) || s(listing.propertyName); row[4] = s(r.unitTypeName); row[5] = +s(u.numUnits) || 1; row[6] = s(r.unitTypeName);
      row[7] = r.from; row[8] = snToDate(r.to); row[9] = +s(u.maxOccupancy) || '';
      row[25] = +r.minStay || 1; row[26] = +r.snRate || ''; row[27] = +r.rackRate || '';
      return row;
    });
  }
  function propertyRow(listing, siteNr){
    var C = window.AvanteCommission, own = !!C && C.ownBookings(listing), bank = listing.bank || {};
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
      s(listing.propertyName2), s(listing.bookingLink), s(listing.ratingLink),
      // Stock Network's Amenities / Activities / Experiences: names, separated by commas.
      (listing.amenities || []).filter(function(a){ return a && a.available === 'Y'; }).map(function(a){ return s(a.item); }).join(', '),
      commaList(listing.activities), commaList(listing.experiences),
      // The site's Bank/Address tab: the linked affiliate's bank details from the hub (admin adds listing.bank).
      s(bank.accountHolder), s(bank.bankName), s(bank.accountType), s(bank.accountNumber), s(bank.branchCode)
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
    // Excel's own built-in date format (format 14), exactly as in the stock
    // files Stock Network has accepted (Jean, 2026-10-27).
    var builtInDate = XLSX.SSF.get_table()[14];
    for(var r = 1; r < data.length; r++) dateCols.forEach(function(c){ var ref = XLSX.utils.encode_cell({ r: r, c: c }); if(ws[ref]) ws[ref].z = builtInDate; });
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
    var hist = openSeasons(listing).map(function(r){ return [s(r.unitTypeName), r.from, r.to, +r.nights || '', +r.minStay || '', +r.rackRate || '', +r.snRate || '', weekText(r), s(r.to) < today ? 'Past' : (sent[seasonKey(r)] ? 'Sent to SN' : 'Not sent yet')]; });
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
    snToDate: snToDate,
    DAY_NAMES: DAY_NAMES,
    dayOf: dayOf,
    dayList: dayList,
    dayRun: dayRun,
    weekText: weekText,
    nightInfo: nightInfo,
    tsNight: tsNight,
    timeshareSlots: timeshareSlots,
    ratesFromSeasons: ratesFromSeasons,
    periodsOf: periodsOf,
    seasonOut: seasonOut,
    openSeasons: openSeasons,
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
