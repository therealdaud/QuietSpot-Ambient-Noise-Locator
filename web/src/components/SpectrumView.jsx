/**
 * SpectrumView.jsx
 *
 * Octave-band bar chart powered by the C/WASM audio engine.
 * Receives bands[] — Float32Array[8] of dB levels for:
 *   63, 125, 250, 500, 1000, 2000, 4000, 8000 Hz
 *
 * If bands is null (WASM not loaded) the component renders nothing.
 */

const BAND_LABELS = ['63', '125', '250', '500', '1K', '2K', '4K', '8K'];

// Map a dB value to a bar height percentage.
// We treat [30 dB, 100 dB] as the visible range.
const MIN_DB = 30;
const MAX_DB = 100;

function barHeight(db) {
  if (!db || db <= MIN_DB) return 2;
  return Math.min(100, Math.round(((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100));
}

function barColor(db) {
  if (!db || db < 50) return '#22c55e';
  if (db < 65)        return '#eab308';
  if (db < 80)        return '#f97316';
  return '#ef4444';
}

export default function SpectrumView({ bands }) {
  if (!bands) return null;

  return (
    <div className="spectrum-view">
      <div className="spectrum-title">Frequency Spectrum</div>
      <div className="spectrum-bars">
        {BAND_LABELS.map((label, i) => {
          const db  = bands[i] ?? 0;
          const pct = barHeight(db);
          const col = barColor(db);
          return (
            <div key={label} className="spectrum-band">
              <div className="spectrum-bar-wrap">
                <div
                  className="spectrum-bar"
                  style={{ height: `${pct}%`, background: col }}
                  title={`${label} Hz — ${db.toFixed(1)} dB`}
                />
              </div>
              <div className="spectrum-label">{label}</div>
            </div>
          );
        })}
      </div>
      <div className="spectrum-note">C/WASM · A-weighted FFT</div>
    </div>
  );
}
