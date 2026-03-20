import { useState, useEffect, useCallback, useRef } from 'react';
import MapView from './components/MapView.jsx';
import SpotPanel from './components/SpotPanel.jsx';
import NoiseMeter from './components/NoiseMeter.jsx';
import { fetchSpots, fetchSpot, postNoise } from './api.js';
import './App.css';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const REFRESH_INTERVAL = 30_000; // 30 seconds

const LEGEND = [
  { label: '< 50 dBA — Very Quiet', color: '#22c55e' },
  { label: '50–65 dBA — Moderate',  color: '#eab308' },
  { label: '65–80 dBA — Loud',      color: '#f97316' },
  { label: '> 80 dBA — Very Loud',  color: '#ef4444' },
];

const NOISE_FILTERS = [
  { id: 'all',      label: 'All' },
  { id: 'quiet',    label: '🟢 Quiet' },
  { id: 'moderate', label: '🟡 Moderate' },
  { id: 'loud',     label: '🟠 Loud' },
  { id: 'veryLoud', label: '🔴 Very Loud' },
];

const TIME_FILTERS = [
  { id: 'all', label: 'All time' },
  { id: '1h',  label: 'Last hour' },
  { id: '6h',  label: 'Last 6h' },
  { id: '24h', label: 'Last 24h' },
];

function matchesNoise(spot, filter) {
  if (filter === 'quiet')    return spot.avg < 50;
  if (filter === 'moderate') return spot.avg >= 50 && spot.avg < 65;
  if (filter === 'loud')     return spot.avg >= 65 && spot.avg < 80;
  if (filter === 'veryLoud') return spot.avg >= 80;
  return true;
}

export default function App() {
  const [spots, setSpots]               = useState([]);
  const [selectedSpot, setSelectedSpot] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [toast, setToast]               = useState('');
  const [toastType, setToastType]       = useState('info');
  const [showLegend, setShowLegend]     = useState(false);
  const [apiError, setApiError]         = useState(false);
  const [noiseFilter, setNoiseFilter]   = useState('all');
  const [timeFilter, setTimeFilter]     = useState('all');
  const [lastUpdated, setLastUpdated]   = useState(null);

  const timeFilterRef = useRef(timeFilter);
  timeFilterRef.current = timeFilter;

  const loadSpots = useCallback(async (since) => {
    try {
      const s = await fetchSpots(since === 'all' ? null : since);
      setSpots(s);
      setLastUpdated(new Date());
      setApiError(false);
    } catch {
      setApiError(true);
    }
  }, []);

  // Initial load + GPS
  useEffect(() => {
    loadSpots(null);
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => showToast('Location unavailable — allow GPS access to record noise.', 'error'),
        { enableHighAccuracy: true },
      );
    }
  }, [loadSpots]);

  // Auto-refresh every 30s using the current time filter
  useEffect(() => {
    const id = setInterval(() => {
      const since = timeFilterRef.current;
      loadSpots(since === 'all' ? null : since);
    }, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [loadSpots]);

  // Reload when time filter changes
  useEffect(() => {
    loadSpots(timeFilter === 'all' ? null : timeFilter);
  }, [timeFilter, loadSpots]);

  async function handleMarkerClick(spot) {
    try {
      const detail = await fetchSpot(spot.key);
      setSelectedSpot(detail);
    } catch {
      showToast('Could not load spot details.', 'error');
    }
  }

  async function handleRecordingComplete({ dBA, note }) {
    if (!userLocation) {
      showToast('Location not available. Please allow GPS access.', 'error');
      return;
    }
    try {
      await postNoise({ ...userLocation, dBA, note });
      showToast(`✓ Saved! ${dBA.toFixed(1)} dBA recorded.`, 'info');
      loadSpots(timeFilter === 'all' ? null : timeFilter);
    } catch (e) {
      showToast('Failed to save: ' + e.message, 'error');
    }
  }

  function showToast(msg, type = 'info') {
    setToast(msg);
    setToastType(type);
    setTimeout(() => setToast(''), 4000);
  }

  const filteredSpots = spots.filter(s => matchesNoise(s, noiseFilter));

  const updatedLabel = lastUpdated
    ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-brand">
          <img src="/logo.png" alt="QuietSpot logo" className="header-logo" />
          <div>
            <h1>QuietSpot</h1>
            <p>Find quiet places near you</p>
          </div>
        </div>

        <div className="header-actions">
          {apiError && (
            <span className="header-badge badge-error">⚠ Backend offline</span>
          )}
          {!apiError && (
            <span className="header-badge badge-ok">
              {filteredSpots.length} spot{filteredSpots.length !== 1 ? 's' : ''}
              {updatedLabel && <> · {updatedLabel}</>}
            </span>
          )}
          <button
            className="legend-toggle"
            onClick={() => setShowLegend(v => !v)}
            title="Toggle legend"
          >
            Legend
          </button>
        </div>
      </header>

      {/* Legend dropdown */}
      {showLegend && (
        <div className="legend-panel">
          {LEGEND.map(item => (
            <div key={item.label} className="legend-item">
              <span className="legend-dot" style={{ background: item.color }} />
              <span>{item.label}</span>
            </div>
          ))}
          <div className="legend-note">Values are approximate — calibration varies by device.</div>
        </div>
      )}

      {/* Filter bar */}
      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">Noise</span>
          {NOISE_FILTERS.map(f => (
            <button
              key={f.id}
              className={`filter-btn${noiseFilter === f.id ? ' active' : ''}`}
              onClick={() => setNoiseFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="filter-divider" />
        <div className="filter-group">
          <span className="filter-label">Time</span>
          {TIME_FILTERS.map(f => (
            <button
              key={f.id}
              className={`filter-btn${timeFilter === f.id ? ' active' : ''}`}
              onClick={() => setTimeFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Map */}
      <div className="map-container">
        <MapView
          spots={filteredSpots}
          userLocation={userLocation}
          onMarkerClick={handleMarkerClick}
          apiKey={MAPS_KEY}
        />
      </div>

      {/* Spot detail panel */}
      {selectedSpot && (
        <SpotPanel spot={selectedSpot} onClose={() => setSelectedSpot(null)} />
      )}

      {/* Noise recorder */}
      <NoiseMeter onComplete={handleRecordingComplete} hasLocation={!!userLocation} />

      {/* Toast */}
      {toast && <div className={`toast toast-${toastType}`}>{toast}</div>}
    </div>
  );
}
