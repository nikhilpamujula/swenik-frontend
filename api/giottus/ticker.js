// Vercel serverless proxy — the browser can't call Giottus directly (CORS),
// so this fetches the ticker server-side and hands it to the page.
export default async function handler(req, res) {
  try {
    const r = await fetch('https://www.giottus.com/api/v2/ticker', {
      headers: { 'User-Agent': 'giottus-lab/1.0' }
    });
    if (!r.ok) throw new Error(`Giottus returned ${r.status}`);
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=3, stale-while-revalidate=10');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
