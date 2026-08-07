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
    if (r.status !== 200) { errors.push(`nse-etf: HTTP ${r.status}`); return null; }
    const j = JSON.parse(r.text);
    return j.data || null;
  } catch (e) {
    errors.push('nse-etf: ' + String(e).slice(0, 150));
    return null;
  }
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
  const [spot, binance, nseRows, amfi] = await Promise.all([
    getSpotAndFx(errors),
    getBinance(errors),
    getNseEtfs(errors),
    getAmfi(errors),
  ]);

  const dutyMult = 1 + (settings.importDutyPct || 0) / 100;
  const gstMult = 1 + (settings.gstPct || 0) / 100;
  const landed = {
    silverInrPerKg: spot.xagUsdOz && spot.usdInr ? +((spot.xagUsdOz / OZT_GRAMS) * 1000 * spot.usdInr * dutyMult * gstMult).toFixed(0) : null,
    goldInrPer10g: spot.xauUsdOz && spot.usdInr ? +((spot.xauUsdOz / OZT_GRAMS) * 10 * spot.usdInr * dutyMult * gstMult).toFixed(0) : null,
    assumes: `spot x USDINR x ${settings.importDutyPct}% duty x ${settings.gstPct}% GST`,
  };

  // ETFs
  const etfs = [];
  if (nseRows) {
    for (const row of nseRows) {
      const f = pickEtfFields(row);
      if (!f.symbol) continue;
      const metal = isMetalEtf(f.symbol, f.name);
      if (!metal) continue;
      const ov = (settings.etfOverrides || {})[f.symbol] || {};
      const threshold = ov.thresholdPct ?? settings.defaultThresholdPct;
      const premiumPct = f.ltp && f.inav ? +(((f.ltp - f.inav) / f.inav) * 100).toFixed(2) : null;
      let indiaVsGlobalPct = null;
      if (ov.gramsPerUnit && f.inav) {
        const inrPerGram = f.inav / ov.gramsPerUnit;
        const landedPerGram = metal === 'silver'
          ? (landed.silverInrPerKg ? landed.silverInrPerKg / 1000 : null)
          : (landed.goldInrPer10g ? landed.goldInrPer10g / 10 : null);
        if (landedPerGram) indiaVsGlobalPct = +(((inrPerGram - landedPerGram) / landedPerGram) * 100).toFixed(2);
      }
      etfs.push({ ...f, metal, premiumPct, thresholdPct: threshold, indiaVsGlobalPct, approxIndiaComparison: !!ov.gramsPerUnit });
    }
    etfs.sort((a, b) => Math.abs(b.premiumPct ?? 0) - Math.abs(a.premiumPct ?? 0));
  }

  // Breaches
  const breaches = [];
  for (const e of etfs) {
    if (e.premiumPct !== null && Math.abs(e.premiumPct) >= e.thresholdPct) {
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
    mfNavs: amfi,
    breaches, sent, errors,
  };
}

module.exports = { run, settings };
