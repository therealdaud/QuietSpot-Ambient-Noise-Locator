import { useState, useRef, useEffect } from 'react';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { classifyNoise } from '../api.js';
import SpectrumView from './SpectrumView';

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

const SOURCE_ICONS = {
  traffic:      '🚗',
  voices:       '🗣️',
  construction: '🏗️',
  nature:       '🌿',
  music:        '🎵',
  hvac:         '❄️',
};


export default function NoiseMeter({ onComplete, hasLocation }) {
  const [phase, setPhase]         = useState('idle');
  const [liveDBA, setLiveDBA]     = useState(null);
  const [countdown, setCountdown] = useState(RECORD_SECONDS);
  const [result, setResult]       = useState(null);   // { dBA, bands, leq }
  const [note, setNote]           = useState('');
  const [error, setError]         = useState('');

  // WASM engine — processAudio / getOctaveBands fall back to JS if not loaded
  const { processAudio, getOctaveBands, calculateLeq,
          getSpectralCentroid, getTemporalVariance, getZeroCrossingRate } = useAudioEngine();

  const audioCtxRef   = useRef(null);
  const streamRef     = useRef(null);
  const analyserRef   = useRef(null);
  const analyserBuf   = useRef(null);
  const rawChunksRef  = useRef([]);    // Float32Array snapshots from AnalyserNode
  const timerRef      = useRef(null);
  const animRef       = useRef(null);
  const sampleRateRef = useRef(44100);

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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation:   false,  // preserve actual room acoustics
          noiseSuppression:   false,  // don't filter out "noise" — that IS our signal
          autoGainControl:    false,  // critical: prevents AGC from compressing dynamic range
        },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sampleRateRef.current = ctx.sampleRate;

      // ── AnalyserNode — live display AND raw sample collection ─────────────
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      analyserBuf.current = new Float32Array(analyser.frequencyBinCount);
      rawChunksRef.current = [];

      // ── Recording state ───────────────────────────────────────────────────
      let secondsLeft = RECORD_SECONDS;
      setCountdown(secondsLeft);
      setPhase('recording');

      // Every animation frame: update live bar AND save a PCM snapshot.
      // Using the AnalyserNode guarantees real data (ScriptProcessorNode has
      // cross-browser reliability issues). Consecutive frames overlap ~90%
      // but the WASM FFT still sees the correct signal energy.
      function animateLive() {
        analyser.getFloatTimeDomainData(analyserBuf.current);
        // Use the WASM engine (with A-weighting) so the live bar matches the
        // final result. Falls back to JS RMS automatically if WASM isn't loaded.
        setLiveDBA(processAudio(analyserBuf.current, ctx.sampleRate));
        rawChunksRef.current.push(new Float32Array(analyserBuf.current));
        animRef.current = requestAnimationFrame(animateLive);
      }
      animRef.current = requestAnimationFrame(animateLive);

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
    // Snapshot the collected chunks before stopAll clears the animation loop
    const chunks = rawChunksRef.current.slice();
    stopAll();

    // Concatenate all AnalyserNode snapshots into one Float32Array
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const allSamples = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      allSamples.set(chunk, offset);
      offset += chunk.length;
    }

    const sr = sampleRateRef.current;

    // Pass the full buffer to the C/WASM engine for accurate analysis
    const dBA      = processAudio(allSamples, sr);
    const bands    = getOctaveBands(allSamples, sr);
    const leq      = calculateLeq(allSamples, sr);
    const centroid = getSpectralCentroid(allSamples, sr);   // Hz  (null = no WASM)
    const variance = getTemporalVariance(allSamples, sr);   // dB² (null = no WASM)
    const zcr      = getZeroCrossingRate(allSamples, sr);   // Hz  (null = no WASM)

    // Show result immediately; source type will appear once the backend responds
    setResult({ dBA, bands, leq, sourceType: null });
    setPhase('done');

    // Ask the Python ML backend to classify the noise source
    if (bands) {
      classifyNoise({ dBA, bands: Array.from(bands), centroid, variance, zcr })
        .then(label => setResult(prev => prev ? { ...prev, sourceType: label ?? 'unknown' } : prev))
        .catch(() => setResult(prev => prev ? { ...prev, sourceType: 'unknown' } : prev));
    }
  }

  function handleSubmit() {
    if (result) onComplete({ dBA: result.dBA, note: note.trim() || undefined, bands: result.bands ?? undefined });
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
            {result.leq != null && (
              <span className="nm-result-leq">Leq {result.leq.toFixed(1)} dBA</span>
            )}
          </div>

          <div className="nm-source">
            {result.sourceType === null
              ? <span className="nm-source-loading">Classifying…</span>
              : result.sourceType === 'unknown'
              ? null
              : <span className="nm-source-label">
                  {SOURCE_ICONS[result.sourceType] ?? '🔊'} {result.sourceType}
                </span>
            }
          </div>

          {/* Octave-band spectrum — only visible when WASM is loaded */}
          <SpectrumView bands={result.bands} />

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
