// server.js — QuietSpot file-storage API with notes + details
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// ------- file storage -------
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'noise.json');

async function ensureStore() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
  try { await fs.access(DATA_FILE); }
  catch { await fs.writeFile(DATA_FILE, JSON.stringify({ samples: [] }, null, 2)); }
}
async function loadDB() {
  await ensureStore();
  const raw = await fs.readFile(DATA_FILE, 'utf8').catch(()=>'{"samples":[]}');
  return JSON.parse(raw || '{"samples": []}');
}
async function saveDB(db) {
  await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
}

// group readings by ~11m tiles (about a building)
const round4 = x => Math.round(x * 10000) / 10000;
const cellKey = (lat, lng) => `${round4(lat)},${round4(lng)}`;

// summaries for map
function summarize(samples) {
  const buckets = new Map();
  for (const s of samples) {
    const k = cellKey(s.lat, s.lng);
    const b = buckets.get(k) || { key:k, latSum:0, lngSum:0, sum:0, n:0 };
    b.latSum += s.lat; b.lngSum += s.lng; b.sum += s.dBA; b.n += 1;
    buckets.set(k, b);
  }
  return [...buckets.values()].map(b => ({
    key: b.key,
    lat: b.latSum / b.n,
    lng: b.lngSum / b.n,
    avg: b.sum / b.n,
    n: b.n
  })).sort((a,b)=>b.n-a.n);
}

// details for one spot
function detailsForKey(samples, key) {
  const [klat, klng] = key.split(',').map(Number);
  const list = samples
    .filter(s => cellKey(s.lat, s.lng) === key)
    .sort((a,b)=> new Date(b.at) - new Date(a.at));
  const n = list.length;
  const avg = n ? list.reduce((acc,s)=>acc+s.dBA,0)/n : 0;
  return {
    key, lat: klat, lng: klng, avg, n,
    samples: list.map(s => ({ dBA: s.dBA, note: s.note || null, at: s.at }))
  };
}

// ------- express -------
app.use(cors());
app.use(express.json());

// health
app.get('/health', async (_req,res) => {
  const db = await loadDB();
  res.json({ ok:true, service:'QuietSpot API', storage:'file', items: db.samples.length });
});

// parse "1h", "6h", "24h" → milliseconds
function parseSince(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)(h|d)$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000);
}

// map summaries
app.get('/spots', async (req,res) => {
  const db = await loadDB();
  const ms = parseSince(req.query.since);
  const samples = ms
    ? db.samples.filter(s => Date.now() - new Date(s.at).getTime() <= ms)
    : db.samples;
  res.json({ ok:true, spots: summarize(samples) });
});

// spot details by key OR coords
app.get('/spot', async (req,res) => {
  const { key, lat, lng } = req.query;
  if (!key && (lat == null || lng == null)) {
    return res.status(400).json({ ok:false, error:'Provide ?key= or ?lat=&lng=' });
  }
  const db = await loadDB();
  const k = key || cellKey(Number(lat), Number(lng));
  res.json({ ok:true, spot: detailsForKey(db.samples, k) });
});

// add a reading (supports note)
app.post('/noise', async (req,res) => {
  const { lat, lng, dBA, note } = req.body || {};
  const num = Number(dBA);
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(num) || num < 20 || num > 120) {
    return res.status(400).json({ ok:false, error:'Invalid lat/lng/dBA' });
  }
  const db = await loadDB();
  db.samples.push({
    lat: Number(lat), lng: Number(lng), dBA: num,
    note: typeof note === 'string' && note.trim() ? note.trim() : undefined,
    at: new Date().toISOString()
  });
  await saveDB(db);
  res.json({ ok:true, saved:{ lat, lng, dBA:num, note: note || null } });
});

app.listen(PORT, () => {
  console.log(`🚀 QuietSpot API (file storage) on http://localhost:${PORT}`);
});
