const COLORS = {
  quiet:    '#22c55e',
  moderate: '#eab308',
  loud:     '#f97316',
  veryLoud: '#ef4444',
};

function noiseColor(avg) {
  if (avg < 50) return COLORS.quiet;
  if (avg < 65) return COLORS.moderate;
  if (avg < 80) return COLORS.loud;
  return COLORS.veryLoud;
}

function noiseLabel(avg) {
  if (avg < 50) return 'Very Quiet';
  if (avg < 65) return 'Moderate';
  if (avg < 80) return 'Loud';
  return 'Very Loud';
}

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function SpotPanel({ spot, onClose }) {
  const color = noiseColor(spot.avg);

  return (
    <div className="spot-panel">
      <div className="spot-panel-header">
        <div className="spot-noise" style={{ color }}>
          <span className="spot-dba">{spot.avg.toFixed(1)}</span>
          <span className="spot-unit"> dBA</span>
        </div>
        <div className="spot-label" style={{ color }}>{noiseLabel(spot.avg)}</div>
        <div className="spot-meta">
          {spot.n} reading{spot.n !== 1 ? 's' : ''} at this location
        </div>
        <button className="close-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="spot-samples">
        {spot.samples.map((s, i) => (
          <div key={i} className="sample-row">
            <span className="sample-dba" style={{ color: noiseColor(s.dBA) }}>
              {s.dBA.toFixed(1)} dBA
            </span>
            {s.note && <span className="sample-note">{s.note}</span>}
            <span className="sample-time">{timeAgo(s.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
