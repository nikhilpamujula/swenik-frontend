// Metal Arb Tracker endpoint — /api/metal/check on the swenik-frontend
// Vercel project itself (filesystem functions win over the /api/* backend
// proxy rewrite, same as the giottus proxies). Reads are open; alert sending
// (?send=1) and test messages (?test=1) require ?secret= to match.
// IMPORTANT: this function needs to run from India-adjacent infrastructure —
// Binance fapi 451-blocks US IPs and NSE favours Indian ones. Add
// "regions": ["bom1"] to the repo's vercel.json (one line) if not present.
const { run, settings } = require('../../lib/metalEngine');

module.exports = async (req, res) => {
  const q = req.query || {};
  const ua = req.headers['user-agent'] || '';
  const authorized = q.secret === settings.secret || ua.startsWith('vercel-cron');
  const send = (q.send === '1' || q.send === 'true') && authorized;
  const test = q.test === '1' && authorized;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const result = await run({ send, test });
  if ((q.send === '1' || q.test === '1') && !authorized) result.errors.push('send/test requested but secret missing or wrong — dry run only');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(result);
};
