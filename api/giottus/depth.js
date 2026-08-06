// Vercel serverless proxy for Giottus order-book depth (one market per call).
//
// TWO cache modes:
//   default      — s-maxage=5 + stale-while-revalidate=15. Cheap for the page's
//                  background verification cycle, BUT the edge may serve a book
//                  up to ~20s old. This was exactly the "open book frozen for
//                  15–20s" flaw: the open-book 3s refresher kept hitting the
//                  same URL and the edge kept answering from cache.
//   ?live=1      — Cache-Control: no-store. Every call goes to Giottus origin.
//                  Used ONLY by the open-book overlay (one book at a time,
//                  ≤4 markets, spaced ~250ms, self-backoff on 429), so the
//                  origin call rate stays tiny while the book you are LOOKING
//                  at is actually live.
export default async function handler(req, res) {
  const m = String((req.query && req.query.market) || '').toLowerCase();
  if (!/^[a-z0-9]{2,20}$/.test(m)) { res.status(400).json({ error: 'bad market' }); return; }
  const live = String((req.query && req.query.live) || '') === '1';
  try {
    const r = await fetch(`https://www.giottus.com/api/v2/depth?market=${m}`, {
      headers: { 'User-Agent': 'giottus-lab/1.0' }
    });
    if (r.status === 429) { res.status(429).json({ error: 'giottus rate limit' }); return; }
    if (!r.ok) throw new Error(`Giottus returned ${r.status}`);
    if (live) res.setHeader('Cache-Control', 'no-store');
    else res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
    res.status(200).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
