// Vercel serverless proxy for Giottus order-book depth (one market per call).
export default async function handler(req, res) {
  const m = String((req.query && req.query.market) || '').toLowerCase();
  if (!/^[a-z0-9]{2,20}$/.test(m)) { res.status(400).json({ error: 'bad market' }); return; }
  try {
    const r = await fetch(`https://www.giottus.com/api/v2/depth?market=${m}`, {
      headers: { 'User-Agent': 'giottus-lab/1.0' }
    });
    if (!r.ok) throw new Error(`Giottus returned ${r.status}`);
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
    res.status(200).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
