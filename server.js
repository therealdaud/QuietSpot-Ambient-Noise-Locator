// server.js  (file-backed JSON storage; no Mongo)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'data', 'readings.json');

app.use(cors());
app.use(express.json());

// ---- tiny helper: load/save JSON safely ----
function loadReadings() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('Could not read data file, starting fresh.', e.message);
    return [];
  }
}
function saveReadings(readings) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(readings, null, 2), 'utf8');
}

// load once at boot
let readings = loadReadings();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'QuietSpot API', storage: 'file', items: readings.length });
});

// Submit a noise reading
app.post('/noise', (req, res) => {
  const { lat, lng, dBA } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof dBA !== 'number') {
    return res.status(400).json({ error: 'lat, lng, dBA (numbers) required' });
  }
  const item = { lat, lng, dBA, at: new Date().toISOString() };
  readings.push(item);
  saveReadings(readings);
  res.status(201).json({ ok: true, saved: item });
});

// Get simple “quiet spots” (lowest averages first)
app.get('/spots', (_req, res) => {
  const key = (x) => `${(x.lat * 100).toFixed(0)}:${(x.lng * 100).toFixed(0)}`;
  const buckets = new Map();
  for (const r of readings) {
    const k = key(r);
    const arr = buckets.get(k) || [];
    arr.push(r);
    buckets.set(k, arr);
  }
  const spots = [...buckets.values()]
    .map((arr) => ({
      lat: arr[0].lat,
      lng: arr[0].lng,
      avg: arr.reduce((s, x) => s + x.dBA, 0) / arr.length,
      n: arr.length,
    }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 20);

  res.json({ ok: true, spots });
});

app.listen(PORT, () => {
  console.log(`🚀 QuietSpot API (file storage) on http://localhost:${PORT}`);
});
