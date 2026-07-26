// ============================================================
// src/manual.js — Track Live data + MANUAL depth execution.
//
// Powers /api/trader/live (order books + edges for every hot coin) and
// /api/trader/manual (fire a leg by hand, sized by % of order-book depth).
//
// Manual execution mirrors the automated engine's discipline: aggressive
// limit orders that never rest (place → poll briefly → cancel remainder),
// sized by walking the live book to the chosen depth %. Paper mode simulates
// the fill off the live book. Every action logs to trader_orders/events so it
// shows in Activity exactly like an automated trade.
// ============================================================

'use strict';

const books = require('./books');
const depth = require('./depth');
const usdtInr = require('./usdtInr');
const store = require('./store');
const wzx = require('./wazirxClient');
const binfut = require('./binanceFuturesClient');
const { request, hmacSha256, toQuery } = require('./httpSigned');

const WAZIRX_FEE = process.env.WAZIRX_FEE_PCT !== undefined ? Number(process.env.WAZIRX_FEE_PCT) / 100 : 0;
const POLL_MS = Number(process.env.TRADER_POLL_MS) || 500;
const MANUAL_LEG_TIMEOUT_MS = Number(process.env.MANUAL_LEG_TIMEOUT_MS) || 3000;

const now = () => Date.now();
const r2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- cached WazirX balances (signed call is rate-limited; refresh ~5s) ----
let balCache = { at: 0, map: {} };
async function balances() {
  if (now() - balCache.at < 5000) return balCache.map;
  if (!wzx.hasKeys()) { balCache = { at: now(), map: {} }; return {}; }
  try {
    const funds = await wzx.getFunds();
    const map = {};
    for (const f of (Array.isArray(funds) ? funds : [])) {
      map[String(f.asset || f.currency).toLowerCase()] = Number(f.free ?? f.balance ?? 0);
    }
    balCache = { at: now(), map };
    return map;
  } catch (e) { return balCache.map; }
}

// ---- live funding rates: public premiumIndex, cached 60s ----
let fundCache = { at: 0, map: {} };
async function fundingMap() {
  if (now() - fundCache.at < 60_000) return fundCache.map;
  try {
    const res = await request({ host: 'fapi.binance.com', path: '/fapi/v1/premiumIndex', method: 'GET', headers: {}, timeoutMs: 8000 });
    if (res.status === 200 && Array.isArray(res.json)) {
      const map = {};
      for (const p of res.json) map[p.symbol] = +(Number(p.lastFundingRate) * 100).toFixed(4); // %/8h
      fundCache = { at: now(), map };
    }
  } catch (e) { /* keep last */ }
  return fundCache.map;
}

// ---- Binance SPOT (signed) — the OTHER leg of the direct arb ----
// Deliberately INSIDE manual.js: no new file means a partial GitHub upload
// can never crash the DO app with a missing require. Uses the same feed the
// trader already streams (stream.binance.com IS the spot market).
// Keys: BINANCE_SPOT_API_KEY / BINANCE_SPOT_SECRET_KEY, falling back to
// BINANCE_API_KEY / BINANCE_SECRET_KEY.
const SPOT_HOST = 'api.binance.com';
function spotKeys() {
  const key = process.env.BINANCE_SPOT_API_KEY || process.env.BINANCE_API_KEY || '';
  const secret = process.env.BINANCE_SPOT_SECRET_KEY || process.env.BINANCE_SECRET_KEY || '';
  return { key, secret, ok: Boolean(key && secret) };
}
function spotHasKeys() { return spotKeys().ok; }
async function spotSigned(method, path, params = {}) {
  const { key, secret, ok } = spotKeys();
  if (!ok) throw new Error('Binance spot keys not configured (BINANCE_API_KEY / BINANCE_SECRET_KEY on the trader server)');
  const qs = toQuery({ ...params, recvWindow: 10000, timestamp: now() });
  const sig = hmacSha256(secret, qs);
  const res = await request({ host: SPOT_HOST, path: `${path}?${qs}&signature=${sig}`, method, headers: { 'X-MBX-APIKEY': key } });
  if (res.status >= 200 && res.status < 300) return res.json;
  throw new Error(`Binance spot ${res.status}: ${(res.json && res.json.msg) || res.text || 'error'}`);
}
async function spotTestKeys() {
  const acct = await spotSigned('GET', '/api/v3/account', { omitZeroBalances: 'true' });
  const usdt = (acct.balances || []).find((b) => b.asset === 'USDT');
  return { ok: true, canTrade: acct.canTrade !== false, usdtFree: usdt ? Number(usdt.free) : 0 };
}
// LOT_SIZE / PRICE_FILTER / NOTIONAL grids, cached per symbol for an hour —
// Binance rejects anything off-grid.
const spotEx = { at: 0, map: {} };
async function spotFilters(symbol) {
  if (!spotEx.map[symbol] || now() - spotEx.at > 3600_000) {
    const res = await request({ host: SPOT_HOST, path: `/api/v3/exchangeInfo?symbol=${symbol}`, method: 'GET', headers: {}, timeoutMs: 10000 });
    const s = res.json && res.json.symbols && res.json.symbols[0];
    if (s) {
      const f = (t) => (s.filters || []).find((x) => x.filterType === t) || {};
      spotEx.at = now();
      spotEx.map[symbol] = {
        stepSize: Number(f('LOT_SIZE').stepSize || 1e-8),
        tickSize: Number(f('PRICE_FILTER').tickSize || 1e-8),
        minNotional: Number(f('NOTIONAL').minNotional || f('MIN_NOTIONAL').minNotional || 5),
      };
    }
  }
  return spotEx.map[symbol] || { stepSize: 1e-8, tickSize: 1e-8, minNotional: 5 };
}
function gridFloor(v, step) {
  const dec = (String(step).split('.')[1] || '').replace(/0+$/, '').length;
  return Number((Math.floor(v / step + 1e-9) * step).toFixed(Math.min(8, dec)));
}

function levels(exchange, symbol, side) {
  const b = books.get(exchange, symbol);
  if (!b) return [];
  return books.toLevels(side === 'asks' ? b.asks : b.bids);
}
const depthTotal = (lv) => lv.reduce((a, l) => a + l.size, 0);

function walkDepth(lv, targetQty) {
  let filled = 0, cost = 0, used = 0;
  for (const l of lv) {
    if (filled >= targetQty - 1e-12) break;
    const take = Math.min(l.size, targetQty - filled);
    filled += take; cost += take * l.price; used++;
  }
  return { qty: filled, cost, avg: filled > 0 ? cost / filled : 0, levelsUsed: used, worstPrice: lv[Math.max(0, used - 1)] ? lv[used - 1].price : (lv[0] && lv[0].price) };
}

// Book levels for the browser. Sizes are NOT rounded to whole units — a
// 0.42 ETH level must stay 0.42, otherwise the page's depth maths sees zero.
// DEPTH = 10 levels a side — Nikhil: "depth of order book 10 is fine".
const DEPTH = 10;
const L = (arr) => arr.slice(0, DEPTH).map((l) => ({
  price: +l.price.toFixed(8),
  size: +l.size.toFixed(l.size >= 1000 ? 1 : l.size >= 1 ? 4 : 8),
}));
// Per-level consumed quantities, index-aligned with L() above, so the page can
// draw the "% consumed by this loop" bar on every book a plan touches.
const T = (arr) => (arr || []).slice(0, DEPTH).map((n) => +Number(n || 0).toFixed(8));

// depth options used for every Track Live quote: walk the whole shown book
// (DEPTH levels), take a whole level if it helps, no cutoff (the UI shows
// the number at every level — you decide where to stop).
const LIVE_DOPTS = { maxLevels: DEPTH, stopPct: -99, maxLevelSharePct: 100, fee: WAZIRX_FEE, binFee: 0.0005 };
// Same walk capped at book level k — one ladder row.
const LVL_DOPTS = (k) => ({ maxLevels: k, stopPct: -99, maxLevelSharePct: 100, fee: WAZIRX_FEE, binFee: 0.0005 });

// "If you go till level 2 you get this %, till level 3 this %" — Nikhil's
// depth analysis. One cumulative row per book level; rows keep coming even
// as the % deteriorates, because choosing the cutoff is HIS call. Stops when
// a deeper level adds no size (books exhausted before DEPTH).
function ladderOf(planAt) {
  const rows = [];
  let prevCost = -1;
  for (let k = 1; k <= DEPTH; k++) {
    const p = planAt(k);
    if (!p) continue;
    if (rows.length && Math.abs(p.costInr - prevCost) < 0.005) break; // deeper adds nothing
    prevCost = p.costInr;
    rows.push({ lvl: k, netPct: +p.netPct.toFixed(3), qty: +p.qty.toFixed(6), costInr: Math.round(p.costInr), profitInr: +p.profitInr.toFixed(2) });
  }
  return rows.length ? rows : null;
}

const px = (n) => (n == null ? null : +Number(n).toFixed(8));
// `taken` maps a book name the PAGE knows ('wzxAsks', 'cuBids', …) to the
// consumed-per-level array for this plan. Names must match the payload keys.
const slim = (p, legs, taken, ladder) => (p ? {
  netPct: +p.netPct.toFixed(3), qty: +p.qty.toFixed(6),
  costInr: Math.round(p.costInr), expectInr: Math.round(p.expectInr),
  profitInr: +p.profitInr.toFixed(2), stoppedBy: p.stoppedBy, legs,
  taken: taken || null, ladder: ladder || null,
} : null);

// ---- /api/trader/live : books + edges for each hot coin ----
// Three strategy families, all computed off the same live books:
//   direct    — buy coin/INR @WazirX, short the coin perp @Binance
//   intraloop — WazirX triangle, one coin: INR → coin → USDT → INR (+ reverse)
//   loop      — WazirX rotation, two coins: INR → c1 → USDT → c2 → INR
async function liveOpps(hotCoins) {
  const rSell = usdtInr.getRate('sell_usdt');
  const rate = rSell ? rSell.rate : null;
  const bal = await balances();
  const fund = await fundingMap();
  const uAsks = levels('wazirx', 'usdtinr', 'asks');
  const uBids = levels('wazirx', 'usdtinr', 'bids');
  const out = [];
  const books4 = new Map(); // coin -> {inrAsks, inrBids, cuAsks, cuBids} for the loop pass

  for (const coin of hotCoins) {
    const C1 = coin.toUpperCase();
    const inrSym = `${coin}inr`, perpSym = `${coin}usdt`, cuSym = `${coin}usdt`;
    const wzxAsks = levels('wazirx', inrSym, 'asks');
    const wzxBids = levels('wazirx', inrSym, 'bids');
    const perpAsks = levels('binance', perpSym, 'asks');
    const perpBids = levels('binance', perpSym, 'bids');
    const cuAsks = levels('wazirx', cuSym, 'asks');
    const cuBids = levels('wazirx', cuSym, 'bids');
    if (wzxAsks.length && wzxBids.length && cuAsks.length && cuBids.length) {
      books4.set(coin, { inrAsks: wzxAsks, inrBids: wzxBids, cuAsks, cuBids });
    }
    // USDT-pair coins (NMR etc.) often have NO INR market on WazirX — keep
    // them as long as the coin/USDT book is live, so pinning them arms the
    // Execute panel instead of starving it.
    if (!wzxAsks.length && !cuAsks.length) continue;

    // --- direct (WazirX spot vs Binance SPOT — the scanner's arb) ---
    // NB: the trader's Binance feed IS the spot stream, so these books and
    // plans price the real transferable arb, not a futures basis.
    const buy = (wzxAsks.length && perpBids.length && rate) ? depth.planHedge(wzxAsks, perpBids, rate, 1e12, LIVE_DOPTS) : null;
    const held = bal[coin] || 0;
    // Reverse direction (buy @Binance → sell @WazirX): shown for EVERY coin,
    // holding or not — Nikhil tracks all coins, not just what he owns.
    let sell = null;
    if (wzxBids.length && perpAsks.length && rate) {
      const perpInr = perpAsks[0].price * rate;
      sell = { netPct: (wzxBids[0].price / perpInr - 1) * 100 };
    }

    // --- intraloop (WazirX triangle, both directions) ---
    let intraA = null, intraB = null;
    if (cuBids.length && uBids.length) intraA = depth.planIntraA(wzxAsks, cuBids, uBids, 1e12, LIVE_DOPTS);
    if (uAsks.length && cuAsks.length && wzxBids.length) intraB = depth.planIntraB(uAsks, cuAsks, wzxBids, 1e12, LIVE_DOPTS);

    out.push({
      coin,
      wzxAsk: wzxAsks[0] ? +wzxAsks[0].price.toFixed(6) : null, wzxBid: wzxBids[0] ? +wzxBids[0].price.toFixed(6) : null,
      perpBid: perpBids[0] ? +perpBids[0].price.toFixed(6) : null,
      perpAsk: perpAsks[0] ? +perpAsks[0].price.toFixed(6) : null,
      cuAsk: cuAsks[0] ? +cuAsks[0].price.toFixed(8) : null,
      cuBid: cuBids[0] ? +cuBids[0].price.toFixed(8) : null,
      basisPct: (perpBids[0] && wzxAsks[0] && rate) ? +(((perpBids[0].price / wzxAsks[0].price * rate) - 1) * 100).toFixed(3) : 0,
      funding: fund[`${C1}USDT`] != null ? fund[`${C1}USDT`] : null, held: +held.toFixed(6),
      buyEdgePct: buy ? +buy.netPct.toFixed(3) : null,
      sellEdgePct: sell ? +sell.netPct.toFixed(3) : null,
      buyPlan: slim(buy, buy ? [
        { side: 'buy', what: `${C1}/INR`, price: px(buy.limits.buySpot), cur: '₹' },
        { side: 'sell', what: `${C1} perp`, price: px(perpBids[0] && perpBids[0].price), cur: '' },
      ] : null, buy ? { wzxAsks: T(buy.taken.buySpot), perpBids: T(buy.taken.shortPerp) } : null,
      buy ? ladderOf((k) => depth.planHedge(wzxAsks, perpBids, rate, 1e12, LVL_DOPTS(k))) : null),
      intraA: slim(intraA, intraA ? [
        { side: 'buy', what: `${C1}/INR`, price: px(intraA.limits.buyInr), cur: '₹' },
        { side: 'sell', what: `${C1}/USDT`, price: px(intraA.limits.sellCu), cur: '' },
        { side: 'sell', what: 'USDT/INR', price: px(intraA.limits.sellUi), cur: '₹' },
      ] : null, intraA ? { wzxAsks: T(intraA.taken.buyInr), cuBids: T(intraA.taken.sellCu), usdtBids: T(intraA.taken.sellUi) } : null,
      intraA ? ladderOf((k) => depth.planIntraA(wzxAsks, cuBids, uBids, 1e12, LVL_DOPTS(k))) : null),
      intraB: slim(intraB, intraB ? [
        { side: 'buy', what: 'USDT/INR', price: px(intraB.limits.buyUi), cur: '₹' },
        { side: 'buy', what: `${C1}/USDT`, price: px(intraB.limits.buyCu), cur: '' },
        { side: 'sell', what: `${C1}/INR`, price: px(intraB.limits.sellInr), cur: '₹' },
      ] : null, intraB ? { usdtAsks: T(intraB.taken.buyUi), cuAsks: T(intraB.taken.buyCu), wzxBids: T(intraB.taken.sellInr) } : null,
      intraB ? ladderOf((k) => depth.planIntraB(uAsks, cuAsks, wzxBids, 1e12, LVL_DOPTS(k))) : null),
      wzxAsks: L(wzxAsks), wzxBids: L(wzxBids),
      perpAsks: L(perpAsks), perpBids: L(perpBids),
      cuAsks: L(cuAsks), cuBids: L(cuBids),
    });
  }

  // --- loop (two coins, one exchange) : every ordered pair of hot coins ---
  const loops = [];
  const coins = [...books4.keys()];
  for (const c1 of coins) {
    for (const c2 of coins) {
      if (c1 === c2) continue;
      const b1 = books4.get(c1), b2 = books4.get(c2);
      const p = depth.planLoop(b1.inrAsks, b1.cuBids, b2.cuAsks, b2.inrBids, 1e12, LIVE_DOPTS);
      if (!p) continue;
      const U1 = c1.toUpperCase(), U2 = c2.toUpperCase();
      loops.push({
        c1, c2, netPct: +p.netPct.toFixed(3),
        qty1: +p.qty1.toFixed(6), qty2: +p.qty2.toFixed(6),
        costInr: Math.round(p.costInr), expectInr: Math.round(p.expectInr),
        profitInr: +p.profitInr.toFixed(2), usdtMid: +p.usdtMid.toFixed(2),
        stoppedBy: p.stoppedBy,
        path: `INR → ${U1} → USDT → ${U2} → INR`,
        legs: [
          { side: 'buy', what: `${U1}/INR`, price: px(p.limits.buyC1), cur: '₹' },
          { side: 'sell', what: `${U1}/USDT`, price: px(p.limits.sellC1u), cur: '' },
          { side: 'buy', what: `${U2}/USDT`, price: px(p.limits.buyC2u), cur: '' },
          { side: 'sell', what: `${U2}/INR`, price: px(p.limits.sellC2), cur: '₹' },
        ],
        // consumed-per-level for each of the four books this rotation walks
        taken: {
          c1Asks: T(p.taken.buyC1), c1uBids: T(p.taken.sellC1u),
          c2uAsks: T(p.taken.buyC2u), c2Bids: T(p.taken.sellC2),
        },
      });
    }
  }
  loops.sort((a, b) => b.netPct - a.netPct);
  // Ladders only for the loops that make the page (top 40) — a full N² ladder
  // pass would be wasted maths on rotations nobody will open.
  const topLoops = loops.slice(0, 40);
  for (const l of topLoops) {
    const b1 = books4.get(l.c1), b2 = books4.get(l.c2);
    if (b1 && b2) l.ladder = ladderOf((k) => depth.planLoop(b1.inrAsks, b1.cuBids, b2.cuAsks, b2.inrBids, 1e12, LVL_DOPTS(k)));
  }

  return {
    opps: out, loops: topLoops, ts: now(), rate: rate ? +rate.toFixed(4) : null,
    usdtAsks: L(uAsks), usdtBids: L(uBids),
  };
}

// ---- one aggressive WazirX limit leg (place → poll → cancel remainder) ----
async function wazirxLeg(order, label, { symbol, side, price, qty }) {
  const { price: P, quantity: Q } = await wzx.roundForMarket(symbol, price, qty);
  if (!(Q > 0)) throw Object.assign(new Error(`qty rounds to zero for ${symbol}`), { stage: label });
  const placedAt = now();
  const placed = await wzx.placeOrder({ symbol, side, price: P, quantity: Q });
  const oid = placed.id ?? placed.orderId;
  await store.addEvent(order.id, label, true, { action: 'placed', symbol, side, price: P, qty: Q, orderId: oid });
  const deadline = placedAt + MANUAL_LEG_TIMEOUT_MS;
  let last = placed;
  while (now() < deadline) {
    await sleep(POLL_MS);
    try { last = await wzx.getOrder(oid); } catch (e) { /* transient */ }
    if (String(last.status || '').toLowerCase() === 'done') break;
  }
  if (String(last.status || '').toLowerCase() === 'done') {
    const filledQty = Number(last.executedQty ?? Q);
    await store.addEvent(order.id, label, true, { action: 'filled', filledQty, price: P, fillMs: now() - placedAt });
    return { filledQty, avgPrice: P };
  }
  try { await wzx.cancelOrder({ symbol, orderId: oid }); } catch (e) { /* may be done */ }
  let final = last; try { final = await wzx.getOrder(oid); } catch (e) {}
  const st = String(final.status || '').toLowerCase();
  const filledQty = Number(final.executedQty ?? 0);
  // Cancel did NOT land → the order is RESTING OPEN on WazirX. Say so loudly
  // instead of pretending it filled — Nikhil gets the open-order popup.
  if (st !== 'done' && st !== 'cancel' && st !== 'rejected') {
    await store.addEvent(order.id, label, false, { action: 'left_open', orderId: oid, filledQty, note: 'cancel did not confirm — order may still be OPEN on WazirX' });
    throw Object.assign(new Error(`order STILL OPEN on WazirX (order id ${oid}, filled ${filledQty} so far) — check Open Orders in the WazirX app and cancel it there`), { stage: label, openOrder: true });
  }
  await store.addEvent(order.id, label, filledQty > 0, { action: 'cancelled_remainder', filledQty, note: filledQty > 0 ? 'partial fill kept' : 'no fill at your price' });
  if (filledQty > 0) return { filledQty, avgPrice: P, partial: true };
  throw Object.assign(new Error(`not filled within ${MANUAL_LEG_TIMEOUT_MS}ms`), { stage: label });
}

// ---- MANUAL execution: buy/sell WazirX or Binance spot, or a chain ----
// mode: 'paper' | 'live'. Returns { ok, id } or { error }.
// Sizing, in order of precedence:
//   qty  — exact coin quantity (the clone sends % OF THE ARB'S WALKED SIZE
//          as a qty, per Nikhil: % of the whole book "is wrong")
//   lvl  — the LADDER ROW: everything walkable down to book level `lvl`
//   pct  — % of the shown book depth (legacy fallback)
// `market`: which WazirX market the wazirx actions trade — 'inr' (default)
// or 'usdt'. USDT-pair arbs (e.g. NMR/USDT, which has NO INR market) were
// impossible before this: the trader always reached for coininr and starved.
async function manualExecute({ coin, coin2, action, pct, lvl, qty: qtyIn, market, mode = 'paper' }) {
  const C = coin.toUpperCase();
  const frac = Math.max(0, Math.min(100, Number(pct))) / 100;
  lvl = Number(lvl) > 0 ? Math.min(15, Math.round(Number(lvl))) : null;
  const qtyReq = Number(qtyIn) > 0 ? Number(qtyIn) : null;
  const lvlTarget = (lv) => lv.slice(0, lvl).reduce((a, l) => a + l.size, 0);
  const target = (lv) => (qtyReq != null ? qtyReq : lvl ? lvlTarget(lv) : depthTotal(lv) * frac);
  const sizeLabel = qtyReq != null ? `${qtyReq} ${C} — ${pct}% of the arb` : lvl ? `till book level ${lvl}` : `${pct}% of depth`;
  const usdtMkt = String(market || '').toLowerCase() === 'usdt';
  const wzxSym = usdtMkt ? `${coin}usdt` : `${coin}inr`;      // the market the wazirx leg trades
  const wzxLabel = `@WazirX${usdtMkt ? ' · USDT market' : ''}`;
  const quote = usdtMkt ? 'USDT' : 'INR';
  const cur = usdtMkt ? '' : '₹';
  const inrSym = `${coin}inr`, perpSym = `${coin}usdt`, futSymbol = `${C}USDT`;
  const isPaper = mode !== 'live';
  // Sweep insurance: cross the walked price a hair so the whole size takes
  // even if the book ticks — without this, fills stopped at the top ask.
  const AGG = Number(process.env.MANUAL_AGGRESSION_BPS || 25) / 10000;

  if (action === 'buy_wazirx') {
    const asks = levels('wazirx', wzxSym, 'asks');
    if (!asks.length) return { error: `no live WazirX ${C}/${quote} ask book` };
    let plan = walkDepth(asks, target(asks));
    if (mode === 'live') {
      const bal = await balances();
      const free = (usdtMkt ? bal.usdt : bal.inr) || 0;
      if (plan.cost > free) { plan = walkDepth(asks, free / (asks[0].price)); } // rough cap to balance
      if (!(plan.qty > 0) || plan.cost > free + 1) return { error: `not enough ${quote} (need ${cur}${Math.round(plan.cost)}, have ${cur}${Math.round(free)})` };
    }
    if (!(plan.qty > 0)) return { error: 'no ask depth' };
    const order = await store.createOrder({ rule_id: null, rule_name: 'Manual', strategy: 'manual', mode, coin,
      path_label: `MANUAL · Buy ${C} ${wzxLabel} (${sizeLabel})`, status: 'buying', stage: 'manual_buy' });
    try {
      let fill;
      if (isPaper) {
        await store.addEvent(order.id, 'manual_buy', true, { action: 'paper_filled', qty: r2(plan.qty), avgPrice: plan.avg, costInr: r2(plan.cost), levelsWalked: plan.levelsUsed });
        fill = { filledQty: plan.qty, avgPrice: plan.avg };
      } else {
        fill = await wazirxLeg(order, 'manual_buy', { symbol: wzxSym, side: 'buy', price: plan.worstPrice * (1 + AGG), qty: plan.qty });
      }
      await store.updateOrder(order.id, { status: 'done', stage: 'done', ok: true,
        spent_inr: mode === 'live' ? r2(fill.filledQty * fill.avgPrice) : 0, profit_inr: 0,
        result: { manual: 'buy', symbol: wzxSym, qty: r2(fill.filledQty), avgPrice: fill.avgPrice, costInr: r2(fill.filledQty * fill.avgPrice), levelsWalked: plan.levelsUsed, partial: !!fill.partial,
          note: `Bought ${r2(fill.filledQty)} ${C} on the ${quote} market walking ${plan.levelsUsed} ask level(s).` } });
      return { ok: true, id: order.id };
    } catch (e) { await store.updateOrder(order.id, { status: 'failed', stage: e.stage || 'manual_buy', ok: false, error: e.message }); return { error: e.message, id: order.id }; }
  }

  if (action === 'sell_wazirx') {
    const bids = levels('wazirx', wzxSym, 'bids');
    if (!bids.length) return { error: `no live WazirX ${C}/${quote} bid book` };
    let held = Infinity;
    if (mode === 'live') { const bal = await balances(); held = bal[coin] || 0; if (!(held > 0)) return { error: `no ${C} balance to sell` }; }
    const plan = walkDepth(bids, Math.min(held, target(bids)));
    if (!(plan.qty > 0)) return { error: 'no bid depth / nothing to sell' };
    const order = await store.createOrder({ rule_id: null, rule_name: 'Manual', strategy: 'manual', mode, coin,
      path_label: `MANUAL · Sell ${C} ${wzxLabel} (${sizeLabel})`, status: 'selling', stage: 'manual_sell' });
    try {
      let fill;
      if (isPaper) {
        await store.addEvent(order.id, 'manual_sell', true, { action: 'paper_filled', qty: r2(plan.qty), avgPrice: plan.avg, proceedsInr: r2(plan.cost), levelsWalked: plan.levelsUsed });
        fill = { filledQty: plan.qty, avgPrice: plan.avg };
      } else {
        fill = await wazirxLeg(order, 'manual_sell', { symbol: wzxSym, side: 'sell', price: plan.worstPrice * (1 - AGG), qty: plan.qty });
      }
      await store.updateOrder(order.id, { status: 'done', stage: 'done', ok: true, spent_inr: 0, profit_inr: 0,
        result: { manual: 'sell', symbol: wzxSym, qty: r2(fill.filledQty), avgPrice: fill.avgPrice, proceedsInr: r2(fill.filledQty * fill.avgPrice), levelsWalked: plan.levelsUsed, partial: !!fill.partial,
          note: `Sold ${r2(fill.filledQty)} ${C} on the ${quote} market walking ${plan.levelsUsed} bid level(s).` } });
      return { ok: true, id: order.id };
    } catch (e) { await store.updateOrder(order.id, { status: 'failed', stage: e.stage || 'manual_sell', ok: false, error: e.message }); return { error: e.message, id: order.id }; }
  }

  if (action === 'hedge_binance') {
    const perpBids = levels('binance', perpSym, 'bids');
    if (!perpBids.length) return { error: 'no live perp bid book' };
    let held = Infinity;
    if (mode === 'live') { const bal = await balances(); held = bal[coin] || 0; if (!(held > 0)) return { error: `buy ${C} first — hedge sizes against your holding` }; }
    const hedgeTarget = Math.min(held, target(perpBids));
    const plan = walkDepth(perpBids, hedgeTarget);
    const rounded = await binfut.roundQty(futSymbol, plan.qty, perpBids[0].price).catch(() => ({ quantity: Math.floor(plan.qty) }));
    const qty = rounded.quantity || Math.floor(plan.qty);
    if (!(qty > 0)) return { error: rounded.reason || 'qty below futures minimum' };
    const order = await store.createOrder({ rule_id: null, rule_name: 'Manual', strategy: 'manual', mode, coin,
      path_label: `MANUAL · Short ${qty} ${futSymbol} @Binance-Fut (${sizeLabel})`, status: 'hedging', stage: 'perp_short' });
    try {
      let hedge;
      if (isPaper) {
        hedge = { executedQty: qty, avgPrice: plan.avg };
        await store.addEvent(order.id, 'perp_short', true, { action: 'paper_filled', qty, symbol: futSymbol, avgPrice: plan.avg, levelsWalked: plan.levelsUsed });
      } else {
        const resp = await binfut.openShort({ symbol: futSymbol, quantity: qty });
        hedge = { executedQty: Number(resp.executedQty || qty), avgPrice: Number(resp.avgPrice || plan.avg), orderId: resp.orderId };
        await store.addEvent(order.id, 'perp_short', true, { action: 'filled', qty: hedge.executedQty, symbol: futSymbol, avgPrice: hedge.avgPrice });
      }
      await store.updateOrder(order.id, { status: 'hedged_open', stage: 'done', ok: true, spent_inr: 0, profit_inr: 0,
        result: { manual: 'hedge', hedge: { symbol: futSymbol, qty: hedge.executedQty, avgPrice: hedge.avgPrice, side: 'SHORT', levelsWalked: plan.levelsUsed },
          note: `Shorted ${hedge.executedQty} ${C} perp walking ${plan.levelsUsed} bid level(s).` } });
      return { ok: true, id: order.id };
    } catch (e) { await store.updateOrder(order.id, { status: 'failed', stage: 'perp_short', ok: false, error: e.message }); return { error: e.message, id: order.id }; }
  }

  // ---- Binance SPOT leg (the other side of the direct arb) ----
  // Paper: fills off the live spot book the trader already streams.
  // Live: signed LIMIT-IOC on api.binance.com — fills what it can at your
  // walked price, cancels the rest, never rests in the book.
  if (action === 'buy_binance' || action === 'sell_binance') {
    const isBuy = action === 'buy_binance';
    const book = levels('binance', perpSym, isBuy ? 'asks' : 'bids');
    if (!book.length) return { error: 'no live Binance spot book' };
    const plan = walkDepth(book, target(book));
    if (!(plan.qty > 0)) return { error: 'no depth to walk' };
    const verb = isBuy ? 'Buy' : 'Sell';
    const order = await store.createOrder({ rule_id: null, rule_name: 'Manual', strategy: 'manual', mode, coin,
      path_label: `MANUAL · ${verb} ${C} @Binance spot (${sizeLabel})`, status: isBuy ? 'buying' : 'selling', stage: 'binance_spot' });
    try {
      let fill;
      if (isPaper) {
        await store.addEvent(order.id, 'binance_spot', true, { action: 'paper_filled', symbol: futSymbol, side: verb.toUpperCase(), qty: +plan.qty.toFixed(8), avgPrice: plan.avg, usdt: r2(plan.cost), levelsWalked: plan.levelsUsed });
        fill = { filledQty: plan.qty, avgPrice: plan.avg };
      } else {
        const f = await spotFilters(futSymbol);
        const q = gridFloor(plan.qty, f.stepSize);
        // cross the walked price slightly so the IOC actually takes the levels
        const rawPx = isBuy ? plan.worstPrice * 1.001 : plan.worstPrice * 0.999;
        const p = gridFloor(rawPx, f.tickSize);
        if (!(q > 0) || q * p < f.minNotional) {
          throw Object.assign(new Error(`order too small for Binance (min ${f.minNotional} USDT)`), { stage: 'binance_spot' });
        }
        const resp = await spotSigned('POST', '/api/v3/order', {
          symbol: futSymbol, side: isBuy ? 'BUY' : 'SELL', type: 'LIMIT', timeInForce: 'IOC',
          quantity: q, price: p, newOrderRespType: 'RESULT',
        });
        const filled = Number(resp.executedQty || 0);
        if (!(filled > 0)) throw Object.assign(new Error('IOC not filled — the book moved; try again'), { stage: 'binance_spot' });
        const quote = Number(resp.cummulativeQuoteQty || 0);
        fill = { filledQty: filled, avgPrice: filled > 0 && quote > 0 ? quote / filled : p };
        await store.addEvent(order.id, 'binance_spot', true, { action: 'filled', symbol: futSymbol, side: verb.toUpperCase(), qty: filled, avgPrice: fill.avgPrice, orderId: resp.orderId });
      }
      await store.updateOrder(order.id, { status: 'done', stage: 'done', ok: true, spent_inr: 0, profit_inr: 0,
        result: { manual: action, symbol: futSymbol, qty: +fill.filledQty.toFixed(8), avgPrice: fill.avgPrice, usdt: r2(fill.filledQty * fill.avgPrice), levelsWalked: plan.levelsUsed, partial: !!fill.partial,
          note: `${verb === 'Buy' ? 'Bought' : 'Sold'} ${+fill.filledQty.toFixed(8)} ${C} on Binance spot walking ${plan.levelsUsed} level(s). Coin transfers between exchanges stay manual.` } });
      return { ok: true, id: order.id };
    } catch (e) {
      await store.updateOrder(order.id, { status: 'failed', stage: e.stage || 'binance_spot', ok: false, error: e.message });
      return { error: e.message, id: order.id };
    }
  }

  if (action === 'intraloop_a' || action === 'intraloop_b') return manualIntraloop({ coin, path: action.endsWith('b') ? 'B' : 'A', pct, lvl, mode });
  if (action === 'loop') return manualLoop({ coin, coin2, pct, lvl, mode });

  return { error: 'unknown action' };
}

// ---- shared: run a chain of WazirX legs (paper or live) ----
// Each leg is { n, side, symbol, price, qty } where qty for legs after the
// first is derived from what the previous leg actually delivered.
async function runWazirxChain(order, legs, isPaper, total) {
  const fills = [];
  let hold = null; // qty produced by the previous leg
  for (const leg of legs) {
    const label = `leg${leg.n}_${leg.side}_${leg.symbol}`;
    await store.updateOrder(order.id, { status: `leg ${leg.n}/${total}`, stage: label });
    // Only leg 1 carries an explicit qty. Every later leg trades what the
    // previous leg ACTUALLY delivered (`hold`) — never what the plan hoped
    // for — so a partial fill shrinks the rest of the chain instead of
    // trying to sell coins we never received.
    const qty = leg.qtyFn ? leg.qtyFn(hold) : (leg.qty != null ? leg.qty : hold);
    if (!(qty > 0)) throw Object.assign(new Error('nothing to trade from the previous leg'), { stage: label });
    let fill;
    if (isPaper) {
      await store.addEvent(order.id, label, true, { action: 'paper_filled', symbol: leg.symbol, side: leg.side, qty: +qty.toFixed(8), price: leg.price });
      fill = { filledQty: qty, avgPrice: leg.price };
    } else {
      fill = await wazirxLeg(order, label, { symbol: leg.symbol, side: leg.side, price: leg.price, qty });
    }
    fills.push({ leg: leg.n, symbol: leg.symbol, side: leg.side, qty: +fill.filledQty.toFixed(8), price: fill.avgPrice });
    hold = leg.outFn ? leg.outFn(fill) : fill.filledQty;
  }
  return { fills, out: hold };
}

// Size a plan to `pct` % of the walkable depth: plan once unbounded to learn
// the max INR the books can absorb, then re-plan at that fraction.
function sizedPlan(planFn, pct) {
  const full = planFn(1e12);
  if (!full) return null;
  const frac = Math.max(1, Math.min(100, Number(pct) || 25)) / 100;
  return planFn(Math.max(1, full.costInr * frac)) || full;
}

// ---- MANUAL intraloop: WazirX triangle, 3 legs, one key ----
async function manualIntraloop({ coin, path, pct, lvl, mode }) {
  const C = coin.toUpperCase();
  const inrSym = `${coin}inr`, cuSym = `${coin}usdt`, uiSym = 'usdtinr';
  const isB = path === 'B';
  const isPaper = mode !== 'live';

  // lvl set → re-plan the exact ladder row (all books capped at level lvl,
  // full size); otherwise size to pct% of the walkable depth as before.
  const dO = lvl ? LVL_DOPTS(lvl) : LIVE_DOPTS;
  const planFn = (budget) => isB
    ? depth.planIntraB(levels('wazirx', uiSym, 'asks'), levels('wazirx', cuSym, 'asks'), levels('wazirx', inrSym, 'bids'), budget, dO)
    : depth.planIntraA(levels('wazirx', inrSym, 'asks'), levels('wazirx', cuSym, 'bids'), levels('wazirx', uiSym, 'bids'), budget, dO);
  const plan = lvl ? planFn(1e12) : sizedPlan(planFn, pct);
  if (!plan) return { error: 'no walkable depth on all three legs right now' };

  if (mode === 'live') {
    const bal = await balances();
    const freeInr = bal.inr || 0;
    if (plan.costInr > freeInr + 1) return { error: `not enough INR (need ₹${Math.round(plan.costInr)}, have ₹${Math.round(freeInr)})` };
  }

  const sized = lvl ? `till book level ${lvl}` : `${pct}% of depth`;
  const pathLabel = isB ? `INR → USDT → ${C} → INR` : `INR → ${C} → USDT → INR`;
  const order = await store.createOrder({ rule_id: null, rule_name: 'Manual', strategy: 'intraloop', mode, coin,
    path_label: `MANUAL · ${pathLabel} (${sized})`, status: 'executing', stage: 'validated' });
  await store.addEvent(order.id, 'validated', true, {
    plan: { path: isB ? 'B' : 'A', qty: r2(plan.qty), costInr: r2(plan.costInr), expectInr: r2(plan.expectInr), netPct: r2(plan.netPct), profitInr: r2(plan.profitInr) },
    depth: { legsUsed: plan.legsUsed, stoppedBy: plan.stoppedBy, sizedTo: sized },
  });

  const legs = isB
    ? [
      { n: 1, side: 'buy', symbol: uiSym, price: plan.limits.buyUi, qty: plan.usdtNeeded },
      { n: 2, side: 'buy', symbol: cuSym, price: plan.limits.buyCu, qtyFn: (usdt) => usdt / (plan.limits.buyCu * (1 + WAZIRX_FEE)) },
      { n: 3, side: 'sell', symbol: inrSym, price: plan.limits.sellInr },
    ]
    : [
      { n: 1, side: 'buy', symbol: inrSym, price: plan.limits.buyInr, qty: plan.qty },
      { n: 2, side: 'sell', symbol: cuSym, price: plan.limits.sellCu, outFn: (f) => f.filledQty * plan.limits.sellCu * (1 - WAZIRX_FEE) },
      { n: 3, side: 'sell', symbol: uiSym, price: plan.limits.sellUi },
    ];

  try {
    const { fills, out } = await runWazirxChain(order, legs, isPaper, 3);
    const gotInr = isB ? out * plan.limits.sellInr * (1 - WAZIRX_FEE) : out * plan.limits.sellUi * (1 - WAZIRX_FEE);
    const profit = gotInr - plan.costInr;
    await store.updateOrder(order.id, { status: 'done', stage: 'done', ok: true,
      spent_inr: mode === 'live' ? r2(plan.costInr) : 0, profit_inr: r2(profit),
      result: { manual: 'intraloop', path: isB ? 'B' : 'A', pathLabel, fills, netPct: r2(plan.netPct),
        costInr: r2(plan.costInr), expectInr: r2(gotInr), profitInr: r2(profit),
        note: `${pathLabel} completed in 3 WazirX legs (${sized}).` } });
    return { ok: true, id: order.id };
  } catch (e) {
    await store.updateOrder(order.id, { status: 'failed', stage: e.stage || 'intraloop', ok: false, error: e.message });
    return { error: e.message, id: order.id };
  }
}

// ---- MANUAL loop: two coins, 4 legs, all on WazirX ----
async function manualLoop({ coin, coin2, pct, lvl, mode }) {
  const c1 = String(coin || '').toLowerCase(), c2 = String(coin2 || '').toLowerCase();
  if (!c2 || c1 === c2) return { error: 'loop needs two different coins' };
  const C1 = c1.toUpperCase(), C2 = c2.toUpperCase();
  const isPaper = mode !== 'live';

  const dO = lvl ? LVL_DOPTS(lvl) : LIVE_DOPTS;
  const planFn = (budget) => depth.planLoop(
    levels('wazirx', `${c1}inr`, 'asks'), levels('wazirx', `${c1}usdt`, 'bids'),
    levels('wazirx', `${c2}usdt`, 'asks'), levels('wazirx', `${c2}inr`, 'bids'), budget, dO);
  const plan = lvl ? planFn(1e12) : sizedPlan(planFn, pct);
  if (!plan) return { error: 'no walkable depth on all four legs right now' };

  if (mode === 'live') {
    const bal = await balances();
    const freeInr = bal.inr || 0;
    if (plan.costInr > freeInr + 1) return { error: `not enough INR (need ₹${Math.round(plan.costInr)}, have ₹${Math.round(freeInr)})` };
  }

  const sized = lvl ? `till book level ${lvl}` : `${pct}% of depth`;
  const pathLabel = `INR → ${C1} → USDT → ${C2} → INR`;
  const order = await store.createOrder({ rule_id: null, rule_name: 'Manual', strategy: 'loop', mode, coin: c1,
    path_label: `MANUAL · ${pathLabel} (${sized})`, status: 'executing', stage: 'validated' });
  await store.addEvent(order.id, 'validated', true, {
    plan: { coin1: c1, coin2: c2, qty1: r2(plan.qty1), qty2: r2(plan.qty2), costInr: r2(plan.costInr), expectInr: r2(plan.expectInr), netPct: r2(plan.netPct), profitInr: r2(plan.profitInr) },
    depth: { legsUsed: plan.legsUsed, stoppedBy: plan.stoppedBy, sizedTo: sized },
  });

  const legs = [
    { n: 1, side: 'buy', symbol: `${c1}inr`, price: plan.limits.buyC1, qty: plan.qty1 },
    { n: 2, side: 'sell', symbol: `${c1}usdt`, price: plan.limits.sellC1u, outFn: (f) => f.filledQty * plan.limits.sellC1u * (1 - WAZIRX_FEE) },
    { n: 3, side: 'buy', symbol: `${c2}usdt`, price: plan.limits.buyC2u, qtyFn: (usdt) => usdt / (plan.limits.buyC2u * (1 + WAZIRX_FEE)) },
    { n: 4, side: 'sell', symbol: `${c2}inr`, price: plan.limits.sellC2 },
  ];

  try {
    const { fills, out } = await runWazirxChain(order, legs, isPaper, 4);
    const gotInr = out * plan.limits.sellC2 * (1 - WAZIRX_FEE);
    const profit = gotInr - plan.costInr;
    await store.updateOrder(order.id, { status: 'done', stage: 'done', ok: true,
      spent_inr: mode === 'live' ? r2(plan.costInr) : 0, profit_inr: r2(profit),
      result: { manual: 'loop', coin1: c1, coin2: c2, pathLabel, fills, netPct: r2(plan.netPct),
        costInr: r2(plan.costInr), expectInr: r2(gotInr), profitInr: r2(profit),
        note: `${pathLabel} completed in 4 WazirX legs (${sized}). No transfers — both hops stay on WazirX.` } });
    return { ok: true, id: order.id };
  } catch (e) {
    await store.updateOrder(order.id, { status: 'failed', stage: e.stage || 'loop', ok: false, error: e.message });
    return { error: e.message, id: order.id };
  }
}

module.exports = { liveOpps, manualExecute, spotHasKeys, spotTestKeys };
