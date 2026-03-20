import { useState, useRef, useEffect } from 'react';

const RECORD_SECONDS = 5;

function dbaColor(dBA) {
  if (!dBA || dBA < 50) return '#22c55e';
  if (dBA < 65) return '#eab308';
  if (dBA < 80) return '#f97316';
  return '#ef4444';
}

function noiseLabel(avg) {
  if (avg < 50) return 'Very Quiet';
  if (avg < 65) return 'Moderate';
  if (avg < 80) return 'Loud';
  return 'Very Loud';
}

function computeRMSdBA(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  const rms = Math.sqrt(sum / buffer.length);
  if (rms < 1e-9) return 20;
  // +90 offset maps raw Web Audio values to a roughly realistic dBA range
  const dB = 20 * Math.log10(rms) + 90;
  return Math.max(20, Math.min(120, dB));
}

export default function NoiseMeter({ onComplete, hasLocation }) {
  const [phase, setPhase]       = useState('idle'); // idle | recording | done
  const [liveDBA, setLiveDBA]   = useState(null);
  const [countdown, setCountdown] = useState(RECORD_SECONDS);
  const [result, setResult]     = useState(null);
  const [note, setNote]         = useState('');
  const [error, setError]       = useState('');

  const audioCtxRef = useRef(null);
  const streamRef   = useRef(null);
  const samplesRef  = useRef([]);
  const timerRef    = useRef(null);
  const animRef     = useRef(null);
  const analyserRef = useRef(null);
  const bufferRef   = useRef(null);

  useEffect(() => () => stopAll(), []);

  function stopAll() {
    clearInterval(timerRef.current);
    cancelAnimationFrame(animRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close();
  }

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      bufferRef.current = new Float32Array(analyser.frequencyBinCount);

      samplesRef.current = [];
      let secondsLeft = RECORD_SECONDS;
      setCountdown(secondsLeft);
      setPhase('recording');

      function sample() {
        analyser.getFloatTimeDomainData(bufferRef.current);
        const dBA = computeRMSdBA(bufferRef.current);
        samplesRef.current.push(dBA);
        setLiveDBA(dBA);
        animRef.current = requestAnimationFrame(sample);
      }
      animRef.current = requestAnimationFrame(sample);

      timerRef.current = setInterval(() => {
        secondsLeft -= 1;
        setCountdown(secondsLeft);
        if (secondsLeft <= 0) finishRecording();
      }, 1000);

    } catch {
      setError('Microphone access denied. Please allow mic access in your browser settings.');
    }
  }

  function finishRecording() {
    stopAll();
    const s = samplesRef.current;
    const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 40;
    setResult({ dBA: avg });
    setPhase('done');
  }

  function handleSubmit() {
    if (result) onComplete({ dBA: result.dBA, note: note.trim() || undefined });
    reset();
  }

  function reset() {
    setPhase('idle');
    setResult(null);
    setNote('');
    setLiveDBA(null);
    setError('');
    setCountdown(RECORD_SECONDS);
  }

  const barPct = liveDBA != null
    ? Math.min(100, ((liveDBA - 20) / 100) * 100)
    : 0;

  return (
    <div className="noise-meter">
      {error && <div className="nm-error">{error}</div>}

      {phase === 'idle' && (
        <button
          className="record-btn"
          onClick={startRecording}
          disabled={!hasLocation}
          title={!hasLocation ? 'Waiting for GPS location…' : 'Measure noise at your current location'}
        >
          🎙 Record Noise
        </button>
      )}

      {phase === 'recording' && (
        <div className="nm-recording">
          <div className="nm-dba" style={{ color: dbaColor(liveDBA) }}>
            {liveDBA != null ? liveDBA.toFixed(1) : '—'}
            <span> dBA</span>
          </div>
          <div className="nm-countdown">Recording… {countdown}s remaining</div>
          <div className="nm-bar">
            <div
              className="nm-bar-fill"
              style={{ width: `${barPct}%`, background: dbaColor(liveDBA) }}
            />
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="nm-done">
          <div className="nm-result">
            <span className="nm-result-dba" style={{ color: dbaColor(result.dBA) }}>
              {result.dBA.toFixed(1)} dBA
            </span>
            <span className="nm-result-label">{noiseLabel(result.dBA)}</span>
          </div>
          <input
            className="nm-note"
            placeholder="Add a note (optional, e.g. 'Library 2nd floor')"
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={100}
          />
          <div className="nm-actions">
            <button className="nm-submit" onClick={handleSubmit}>Save to Map</button>
            <button className="nm-cancel" onClick={reset}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
