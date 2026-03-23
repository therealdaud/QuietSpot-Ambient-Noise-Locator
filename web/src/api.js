const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export async function fetchSpots(since) {
  const url = since ? `${BASE}/spots?since=${since}` : `${BASE}/spots`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to fetch spots');
  return data.spots;
}

export async function fetchSpot(key) {
  const res = await fetch(`${BASE}/spot?key=${encodeURIComponent(key)}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to fetch spot');
  return data.spot;
}

export async function classifyNoise({ dBA, bands, centroid, variance, zcr }) {
  const res = await fetch(`${BASE}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: 0, lng: 0, dBA,
      bands:    bands    ?? null,
      centroid: centroid ?? null,
      variance: variance ?? null,
      zcr:      zcr      ?? null,
    }),
  });
  const data = await res.json();
  return data.label ?? null;   // e.g. 'traffic', 'voices', 'ambient', null
}

export async function postNoise({ lat, lng, dBA, note, bands }) {
  const res = await fetch(`${BASE}/noise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, dBA, note, bands: bands ?? null }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Failed to save reading');
  return data.saved;   // now includes source_type + confidence
}
