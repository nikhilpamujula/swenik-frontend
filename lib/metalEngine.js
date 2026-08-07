// Metal Arb Tracker engine — lives INSIDE the swenik-frontend Vercel project
// (his call: no separate deployment, no extra cost). Same-origin function at
// /api/metal/check; the Others tab fetches it directly, no CORS needed.
// Secrets: Telegram token/chat + the send-secret come from Vercel env vars
// first (METAL_TG_TOKEN / METAL_TG_CHAT / METAL_SECRET) so nothing sensitive
// has to live in the repo file; metal-settings.json holds the strategy knobs.
const fileSettings = require('../metal-settings.json');
const settings = {
  ...fileSettings,
  secret: process.env.METAL_SECRET || fileSettings.secret,
  telegram: {
    botToken: process.env.METAL_TG_TOKEN || (fileSettings.telegram || {}).botToken || '',
    chatId: process.env.METAL_TG_CHAT || (fileSettings.telegram || {}).chatId || '',
  },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const OZT_GRAMS = 31.1034768;

async function fetchText(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      ...opts,
      headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(to);
  }
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------- Spot metals + FX (multiple fallbacks) ----------
async function getSpotAndFx(errors) {
  const out = { xauUsdOz: null, xagUsdOz: null, usdInr: null, sources: {} };

  // gold-api.com — free, no key
  try {
    const [xau, xag] = await Promise.all([
      fetchText('https://api.gold-api.com/price/XAU'),
      fetchText('https://api.gold-api.com/price/XAG'),
    ]);
    const jXau = JSON.parse(xau.text);
    const jXag = JSON.parse(xag.text);
    if (num(jXau.price)) { out.xauUsdOz = num(jXau.price); out.sources.xau = 'gold-api.com'; }
    if (num(jXag.price)) { out.xagUsdOz = num(jXag.price); out.sources.xag = 'gold-api.com'; }
  } catch (e) { errors.push('gold-api: ' + String(e).slice(0, 120)); }

  // stooq fallback for metals + USDINR
  if (!out.xauUsdOz || !out.xagUsdOz || !out.usdInr) {
    try {
      const r = await fetchText('https://stooq.com/q/l/?s=xauusd,xagusd,usdinr&f=sd2t2ohlcv&e=csv');
      for (const line of r.text.trim().split('\n').slice(1)) {
        const parts = line.split(',');
        const sym = (parts[0] || '').toUpperCase();
        const close = num(parts[6]);
        if (!close) continue;
        if (sym.includes('XAUUSD') && !out.xauUsdOz) { out.xauUsdOz = close; out.sources.xau = 'stooq'; }
        if (sym.includes('XAGUSD') && !out.xagUsdOz) { out.xagUsdOz = close; out.sources.xag = 'stooq'; }
        if (sym.includes('USDINR') && !out.usdInr) { out.usdInr = close; out.sources.usdInr = 'stooq'; }
      }
    } catch (e) { errors.push('stooq: ' + String(e).slice(0, 120)); }
  }

  // er-api fallback for USDINR
  if (!out.usdInr) {
    try {
      const r = await fetchText('https://open.er-api.com/v6/latest/USD');
      const j = JSON.parse(r.text);
      if (j && j.rates && num(j.rates.INR)) { out.usdInr = num(j.rates.INR); out.sources.usdInr = 'open.er-api.com'; }
    } catch (e) { errors.push('er-api: ' + String(e).slice(0, 120)); }
  }

  return out;
}

// ---------- Binance perps ----------
async function getBinance(errors) {
  const out = [];
  for (const sym of settings.binanceSymbols || []) {
    try {
      const r = await fetchText(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`);
      const j = JSON.parse(r.text);
      if (j.code) { errors.push(`binance ${sym}: ${j.msg || j.code}`); continue; }
      const mark = num(j.markPrice), index = num(j.indexPrice), funding = num(j.lastFundingRate);
      out.push({
        symbol: sym,
        markPrice: mark,
        indexPrice: index,
        basisPct: mark && index ? +(((mark - index) / index) * 100).toFixed(3) : null,
        fundingRatePct: funding !== null ? +(funding * 100).toFixed(4) : null,
        fundingDailyPct: funding !== null ? +(funding * 100 * 3).toFixed(3) : null,
        nextFundingTime: j.nextFundingTime || null,
      });
    } catch (e) { errors.push(`binance ${sym}: ` + String(e).slice(0, 120)); }
  }
  return out;
}

// ---------- NSE ETF list (price + iNAV) ----------
async function getNseEtfs(errors) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.nseindia.com/market-data/exchange-traded-funds-etf',
  };
  try {
    // warm up cookies
    const warm = await fetchText('https://www.nseindia.com/', { headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
    let cookie = '';
    try {
      const sc = warm.headers.getSetCookie ? warm.headers.getSetCookie() : [];
      cookie = sc.map((c) => c.split(';')[0]).join('; ');
    } catch (_) {}
    const r = await fetchText('https://www.nseindia.com/api/etf', { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } });
    if (r.status !== 200) { errors.push(`nse-etf: HTTP ${r.status}`); return { rows: null, cookie }; }
    const j = JSON.parse(r.text);
    return { rows: j.data || null, cookie };
  } catch (e) {
    errors.push('nse-etf: ' + String(e).slice(0, 150));
    return { rows: null, cookie: '' };
  }
}

// iNAV fallback stage 2 — NSE's per-symbol quote API. Seen live 7 Aug: the
// /api/etf list ships prices+names but NO iNAV values, which kills the primary
// premium signal. quote-equity carries iNavValue for ETFs; reuse the warmed
// cookie, cap the calls, space them.
async function getNseInav(sym, cookie, errors) {
  try {
    const r = await fetchText(`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(sym)}`, {
      headers: { Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
                 Referer: 'https://www.nseindia.com/get-quotes/equity?symbol=' + encodeURIComponent(sym),
                 ...(cookie ? { Cookie: cookie } : {}) } });
    if (r.status !== 200) { errors.push(`nse-quote ${sym}: HTTP ${r.status}`); return null; }
    const j = JSON.parse(r.text);
    const p = j.priceInfo || {};
    return num(p.iNavValue ?? p.inavValue ?? j.iNavValue ?? p.iNav ?? j.inav) || null;
  } catch (e) { errors.push(`nse-quote ${sym}: ` + String(e).slice(0, 100)); return null; }
}

// iNAV fallback stage 3 — AMFI end-of-day official NAV, token-matched by fund
// name. EOD is APPROXIMATE for an intraday premium (gold/silver move overnight)
// so anything computed from it is labelled 'amfi-eod' and shown with a ~.
function amfiInavMatch(etf, amfiRows) {
  const stop = new Set(['etf', 'fund', 'india', 'exchange', 'traded', 'scheme', 'growth', 'plan', 'direct', 'the', 'of']);
  const toks = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !stop.has(t));
  const want = new Set([...toks(etf.name), etf.metal, String(etf.symbol || '').toLowerCase()]);
  let best = null, bestScore = 0;
  for (const row of amfiRows || []) {
    const nToks = toks(row.name);
    if (!nToks.includes(etf.metal)) continue;               // must be the same metal
    let score = 0;
    for (const t of nToks) if (want.has(t)) score++;
    if (String(row.name).toLowerCase().replace(/[^a-z0-9]/g, '').includes(String(etf.symbol || '').toLowerCase())) score += 2;
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return bestScore >= 2 ? best : null;
}

function pickEtfFields(row) {
  // NSE field names vary; be defensive
  const symbol = row.symbol || row.Symbol || null;
  const name = row.assets || row.meta?.companyName || row.companyName || '';
  const ltp = num(row.ltP ?? row.ltp ?? row.lastPrice);
  const inav = num(row.nav ?? row.iNav ?? row.inav ?? row.iNavValue);
  const qty = num(row.qty ?? row.totalTradedVolume);
  const per = num(row.per ?? row.pChange);
  return { symbol, name, ltp, inav, qty, changePct: per };
}

function isMetalEtf(sym, name) {
  const s = `${sym} ${name}`.toLowerCase();
  if (s.includes('silver')) return 'silver';
  if (s.includes('gold')) return 'gold';
  return null;
}

// ---------- AMFI daily NAVs (ETF official NAV + MF/FoF NAVs) ----------
async function getAmfi(errors) {
  try {
    const r = await fetchText('https://www.amfiindia.com/spages/NAVAll.txt', {}, 20000);
    if (r.status !== 200) { errors.push(`amfi: HTTP ${r.status}`); return []; }
    const rows = [];
    const kws = (settings.mfKeywords || []).map((k) => k.toLowerCase());
    const excl = (settings.mfExclude || []).map((k) => k.toLowerCase());
    for (const line of r.text.split('\n')) {
      const parts = line.split(';');
      if (parts.length < 6) continue;
      const name = (parts[3] || '').trim();
      const lname = name.toLowerCase();
      if (!kws.some((k) => lname.includes(k))) continue;
      if (excl.some((k) => lname.includes(k))) continue;
      // skip IDCW variants to reduce noise; keep Growth + ETFs
      if (/idcw|dividend/i.test(name)) continue;
      const nav = num(parts[4]);
      if (!nav) continue;
      rows.push({ code: parts[0].trim(), name, nav, date: (parts[5] || '').trim() });
    }
    return rows;
  } catch (e) {
    errors.push('amfi: ' + String(e).slice(0, 120));
    return [];
  }
}

// ---------- Telegram ----------
async function sendTelegram(text, errors) {
  const { botToken, chatId } = settings.telegram || {};
  if (!botToken || !chatId) { errors.push('telegram: botToken/chatId not configured'); return false; }
  try {
    const r = await fetchText(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = JSON.parse(r.text);
    if (!j.ok) { errors.push('telegram: ' + (j.description || r.status)); return false; }
    return true;
  } catch (e) { errors.push('telegram: ' + String(e).slice(0, 120)); return false; }
}

// ---------- Main ----------
async function run({ send = false, test = false } = {}) {
  const errors = [];
  const [spot, binance, nseRes, amfi] = await Promise.all([
    getSpotAndFx(errors),
    getBinance(errors),
    getNseEtfs(errors),
    getAmfi(errors),
  ]);
  const nseRows = nseRes.rows, nseCookie = nseRes.cookie;

  const dutyMult = 1 + (settings.importDutyPct || 0) / 100;
  const gstMult = 1 + (settings.gstPct || 0) / 100;
  const landed = {
    silverInrPerKg: spot.xagUsdOz && spot.usdInr ? +((spot.xagUsdOz / OZT_GRAMS) * 1000 * spot.usdInr * dutyMult * gstMult).toFixed(0) : null,
    goldInrPer10g: spot.xauUsdOz && spot.usdInr ? +((spot.xauUsdOz / OZT_GRAMS) * 10 * spot.usdInr * dutyMult * gstMult).toFixed(0) : null,
    assumes: `spot x USDINR x ${settings.importDutyPct}% duty x ${settings.gstPct}% GST`,
  };

  // ETFs — collect first, fill missing iNAV via the fallback chain, THEN
  // compute premiums/verdicts so every route benefits from the filled data.
  const etfs = [];
  if (nseRows) {
    for (const row of nseRows) {
      const f = pickEtfFields(row);
      if (!f.symbol) continue;
      const metal = isMetalEtf(f.symbol, f.name);
      if (!metal) continue;
      const ov = (settings.etfOverrides || {})[f.symbol] || {};
      etfs.push({ ...f, metal, thresholdPct: ov.thresholdPct ?? settings.defaultThresholdPct,
                  gramsPerUnit: ov.gramsPerUnit || null,
                  inavSource: f.inav != null ? 'nse-live' : null });
    }
  }

  // Stage 2: NSE quote-equity for symbols the list left blank (≤8/run, spaced).
  const missing = etfs.filter(e => e.inav == null).slice(0, 12);
  for (const e of missing) {
    const v = await getNseInav(e.symbol, nseCookie, errors);
    if (v) { e.inav = v; e.inavSource = 'nse-quote'; }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Stage 3 (AMFI NAV fill) REMOVED — 7 Aug incident: token-matching paired
  // ETFs with Fund-of-Fund schemes and printed +1972% "premiums". A confident
  // wrong number is worse than a dash. AMFI stays display-only (MF section);
  // premium comes from LIVE iNAV or not at all.

  // Signals — his call, 7 Aug: tally against Binance XAU/XAG, not domestic.
  // Two bases, in order of trust:
  //   1. LIVE iNAV premium (nse-live / nse-quote only)
  //   2. Binance parity: price vs gramsPerUnit x (XAU/XAG index / ozt) x USDINR.
  //      Raw parity carries the STRUCTURAL India premium (duty+GST), so the
  //      tradeable number is the DEVIATION from that baseline, not the raw gap.
  const dutyGstBaselinePct = +(((dutyMult * gstMult) - 1) * 100).toFixed(2);
  const perpFor = (metal) => (binance || []).find((b) => (metal === 'gold' ? /XAU/ : /XAG/).test(b.symbol || ''));
  for (const e of etfs) {
    e.premiumPct = (e.ltp && e.inav) ? +(((e.ltp - e.inav) / e.inav) * 100).toFixed(2) : null;
    e.vsBinancePct = null;
    const perp = perpFor(e.metal);
    const globalOz = (perp && (perp.indexPrice || perp.markPrice)) || (e.metal === 'gold' ? spot.xauUsdOz : spot.xagUsdOz);
    if (e.gramsPerUnit && e.ltp && globalOz && spot.usdInr) {
      const impliedInr = (globalOz / OZT_GRAMS) * spot.usdInr * e.gramsPerUnit;
      e.vsBinancePct = +(((e.ltp - impliedInr) / impliedInr) * 100).toFixed(2);
    }
  }
  etfs.sort((a, b) => Math.abs(b.premiumPct ?? b.vsBinancePct ?? 0) - Math.abs(a.premiumPct ?? a.vsBinancePct ?? 0));

  const conclusions = [];
  for (const e of etfs) {
    const thr = e.thresholdPct ?? settings.defaultThresholdPct ?? 2;
    const perp = perpFor(e.metal);
    const carry = perp && perp.fundingDailyPct != null ? `${perp.fundingDailyPct}%/day` : null;
    const perpSym = perp ? perp.symbol : (e.metal === 'gold' ? 'XAUUSDT' : 'XAGUSDT');
    const liveInav = e.inavSource === 'nse-live' || e.inavSource === 'nse-quote';
    // DATA SANITY — the 7 Aug lesson: an ETF "trading" >30% from its own NAV
    // is a data problem, not a trade. Say so; never rank it.
    if (liveInav && e.premiumPct !== null && Math.abs(e.premiumPct) > 30) {
      e.verdict = { action: 'DATA_SUSPECT', why: `premium ${e.premiumPct}% vs iNAV is implausible — treated as bad data, not a trade` };
      continue;
    }
    let basis = null, value = null, dev = null;
    if (liveInav && e.premiumPct !== null) { basis = 'iNAV'; value = e.premiumPct; dev = e.premiumPct; }
    else if (e.vsBinancePct !== null) { basis = 'Binance parity'; value = e.vsBinancePct; dev = +(e.vsBinancePct - dutyGstBaselinePct).toFixed(2); }
    if (basis === null) { e.verdict = { action: 'NO_DATA', why: 'no live iNAV; add gramsPerUnit in metal-settings.json for a Binance-parity estimate' }; continue; }
    const ctx = basis === 'iNAV'
      ? `${value > 0 ? '+' : ''}${value}% vs live iNAV`
      : `${value > 0 ? '+' : ''}${value}% vs ${perpSym} parity (structural duty+GST ≈ ${dutyGstBaselinePct}% → deviation ${dev > 0 ? '+' : ''}${dev}%)`;
    if (dev >= thr) {
      e.verdict = { action: 'SHORT_ETF', why: `${ctx} — rich beyond ±${thr}%`,
        hedge: `hedge: LONG ${perpSym} perp${carry ? ` · carry ${carry}` : ''} — FEMA grey, your call (MCX ${e.metal} = domestic alt)` };
    } else if (dev <= -thr) {
      e.verdict = { action: 'BUY_ETF', why: `${ctx} — cheap beyond ±${thr}%`,
        hedge: `hedge: SHORT ${perpSym} perp${carry ? ` · carry ${carry}` : ''} — FEMA grey, your call (MCX ${e.metal} = domestic alt)` };
    } else {
      e.verdict = { action: 'HOLD', why: `${ctx} — inside the ±${thr}% band, no edge` };
    }
    if (e.verdict.action === 'SHORT_ETF' || e.verdict.action === 'BUY_ETF') {
      conclusions.push({ symbol: e.symbol, metal: e.metal, action: e.verdict.action,
        premiumPct: value, basis, inavSource: e.inavSource, why: e.verdict.why, hedge: e.verdict.hedge });
    }
  }
  conclusions.sort((a, b) => Math.abs(b.premiumPct) - Math.abs(a.premiumPct));

  // Breaches
  const breaches = [];
  for (const e of etfs) {
    const liveSrc = e.inavSource === 'nse-live' || e.inavSource === 'nse-quote';
    if (e.premiumPct !== null && liveSrc && Math.abs(e.premiumPct) >= e.thresholdPct && Math.abs(e.premiumPct) <= 30) {
      breaches.push({ type: 'etf-premium', symbol: e.symbol, metal: e.metal, premiumPct: e.premiumPct, thresholdPct: e.thresholdPct, ltp: e.ltp, inav: e.inav });
    }
  }
  for (const b of binance) {
    if (b.fundingDailyPct !== null && Math.abs(b.fundingDailyPct) >= (settings.fundingAlertDailyPct || 999)) {
      breaches.push({ type: 'funding', symbol: b.symbol, fundingDailyPct: b.fundingDailyPct });
    }
  }

  // Telegram
  let sent = false;
  if (send && (breaches.length || test)) {
    const lines = ['<b>Metal Arb Alert</b>'];
    if (test && !breaches.length) lines.push('Test message — system wired up OK.');
    for (const b of breaches) {
      if (b.type === 'etf-premium') lines.push(`${b.symbol} (${b.metal}): premium <b>${b.premiumPct}%</b> vs iNAV (thr ${b.thresholdPct}%) | LTP ${b.ltp} / iNAV ${b.inav}`);
      if (b.type === 'funding') lines.push(`${b.symbol}: funding <b>${b.fundingDailyPct}%/day</b> — hedge carry cost elevated`);
    }
    if (spot.xagUsdOz) lines.push(`Spot: XAG $${spot.xagUsdOz}/oz, XAU $${spot.xauUsdOz}/oz, USDINR ${spot.usdInr}`);
    sent = await sendTelegram(lines.join('\n'), errors);
  }

  return {
    at: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'unknown',
    spot, landed, binance, etfs,
    conclusions,
    mfNavs: amfi,
    breaches, sent, errors,
  };
}

module.exports = { run, settings };
