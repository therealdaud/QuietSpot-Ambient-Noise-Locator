# 🤫 QuietSpot

**Crowd-sourced noise level map.** Find quiet places near you — or contribute a reading from wherever you are.

🔗 **Live demo:** [quietspotweb.vercel.app](https://quietspotweb.vercel.app)

> ⚠️ The backend runs on Render's free tier, which spins down after 15 minutes of inactivity. The first load may take ~30 seconds for the spots to appear — just give it a moment.

---

## What it does

- **Records noise** — hit Record, allow mic access, and the app measures ambient sound for 5 seconds using your device's microphone
- **Pins it on the map** — your reading gets saved to your GPS location and displayed as a color-coded marker
- **Shows nearby spots** — green markers are quiet, red are loud, with the average dBA shown on each pin
- **Click any marker** — see all individual readings at that spot with notes and timestamps
- **Filter the map** — by noise level (Quiet / Moderate / Loud / Very Loud) or by time (last hour, 6h, 24h)
- **Auto-refreshes** every 30 seconds — new readings from other users appear without reloading the page

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React, Vite, Google Maps JavaScript API, Web Audio API |
| Backend | Node.js, Express |
| Deployment | Vercel (frontend) · Render (backend) |

---

## Run locally

```bash
# Backend (port 5000)
npm install
node server.js

# Frontend (port 3000)
cd web
npm install
npm run dev
```

Add a `web/.env` file:
```
VITE_GOOGLE_MAPS_API_KEY=your_key_here
VITE_API_URL=http://localhost:5000
```
