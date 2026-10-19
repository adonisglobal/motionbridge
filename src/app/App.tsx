import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { MotionClient } from '../tracking/motion-client';
import type { MotionFrame, SmoothingPreset } from '../tracking/types';
import { createSampleTimes, findMotionFrame, loadVideoMetadata, sampleVideo } from '../video/video';
import { drawSkeleton } from '../ui/skeleton';
import { CharacterPreview } from '../ui/CharacterPreview';
import { BONE_NAMES } from '../motion/canonical';

type Phase = 'idle' | 'loading-model' | 'analyzing' | 'complete' | 'cancelled' | 'error';
type VideoAsset = { url: string; name: string; size: number; width: number; height: number; duration: number };
const MAX_DURATION = 60;
const MAX_SIZE = 250 * 1024 * 1024;
const presets: Record<SmoothingPreset, string> = { raw: 'Raw', light: 'Light', balanced: 'Balanced', smooth: 'Smooth' };
const phaseLabels: Record<Phase, string> = {
  idle: 'Waiting for a video', 'loading-model': 'Preparing the motion model', analyzing: 'Extracting motion',
  complete: 'Analysis complete', cancelled: 'Analysis cancelled', error: 'Analysis failed',
};

function Icon({ name, size = 20 }: { name: 'upload' | 'play' | 'pause' | 'back' | 'forward' | 'check' | 'file' | 'shield' | 'arrow' | 'close'; size?: number }) {
  const paths = {
    upload: <><path d="M12 16V3m-5 5 5-5 5 5" /><path d="M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
    play: <path d="m9 5 11 7-11 7V5Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    back: <><path d="M6 5v14m13-14L8 12l11 7V5Z" /></>,
    forward: <><path d="M18 5v14M5 5l11 7-11 7V5Z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    file: <><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5" /><path d="m10 11 5 3-5 3v-6Z" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${Math.floor(safe % 60).toString().padStart(2, '0')}.${Math.floor((safe % 1) * 10)}`;
}

function SkeletonMark() {
  return <svg className="skeleton-mark" viewBox="0 0 280 300" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="2"><circle cx="140" cy="48" r="22" /><path d="M140 70v29m-42 12 42-12 42 12M98 111l-30 44-22-31m136-13 30 44 22-31M140 99v81m-33 5 33-5 33 5m-75-74 9 74m75-74-9 74m-66 0-15 49 10 42m71-91 15 49-10 42M92 234l48-54 48 54" /></g>
    <g fill="currentColor">{[[140,99],[98,111],[182,111],[68,155],[212,155],[46,124],[234,124],[140,180],[107,185],[173,185],[92,234],[188,234],[102,276],[178,276]].map(([x,y], i) => <circle key={i} cx={x} cy={y} r="4" />)}</g>
    <g stroke="currentColor" opacity=".2"><path d="M20 20h32M20 20v32m240-32h-32m32 0v32M20 280h32m-32 0v-32m240 32h-32m32 0v-32" /><path d="M0 150h280M140 0v300" strokeDasharray="3 6" /></g>
  </svg>;
}

export default function App() {
  const [asset, setAsset] = useState<VideoAsset>();
  const [mediaLoading, setMediaLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [frames, setFrames] = useState<MotionFrame[]>([]);
  const [fps, setFps] = useState(24);
  const [smoothing, setSmoothing] = useState<SmoothingPreset>('balanced');
  const [raw, setRaw] = useState(false);
  const [showFace, setShowFace] = useState(true);
  const [showHands, setShowHands] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [metricsAcknowledged, setMetricsAcknowledged] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 430 });
  const [referenceTimestamp, setReferenceTimestamp] = useState<number>();
  const viewportRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<MotionClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const urlRef = useRef('');
  const runRef = useRef(0);
  const startRef = useRef(0);
  const busy = phase === 'loading-model' || phase === 'analyzing';
  const total = asset ? createSampleTimes(asset.duration, fps).length : 0;
  const percent = total ? Math.min(100, Math.round(frames.length / total * 100)) : 0;
  const analyzedCoverage = asset && frames.length ? Math.min(100, (frames[frames.length - 1].timestampMs / 1000 + 1 / fps) / asset.duration * 100) : 0;
  const current = findMotionFrame(frames, time);
  const reference = useMemo(() => {
    if (referenceTimestamp !== undefined) return frames.find(frame => frame.timestampMs === referenceTimestamp)?.canonical;
    const candidates = frames.flatMap(frame => frame.canonical?.valid ? [frame.canonical] : []);
    const complete = candidates.find(frame => !frame.needsReview && BONE_NAMES.every(name => frame.bones[name].confidence >= .35));
    if (complete) return complete;
    // Prefer the most fully observed body when no frame sees all extremities.
    return candidates.reduce<typeof candidates[number] | undefined>((best, frame) => {
      const score = (value: typeof frame) => BONE_NAMES.filter(name => value.bones[name].confidence >= .35).length;
      return !best || score(frame) > score(best) ? frame : best;
    }, undefined);
  }, [frames, referenceTimestamp]);
  const referenceIncomplete = reference && (reference.needsReview || BONE_NAMES.some(name => reference.bones[name].confidence < .35));
  const detectedCount = frames.filter(frame => frame.raw.pose.length > 0 && frame.confidence >= 0.45).length;
  const detectionRate = frames.length ? Math.round(detectedCount / frames.length * 100) : 0;
  const averageMs = frames.length ? Math.round(frames.reduce((sum, frame) => sum + frame.inferenceMs, 0) / frames.length) : 0;

  useEffect(() => () => {
    runRef.current++;
    abortRef.current?.abort();
    loadAbortRef.current?.abort();
    clientRef.current?.dispose();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let active = true;
    let callbackId = 0;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const update = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (!active) return;
        setTime(metadata.mediaTime);
        callbackId = video.requestVideoFrameCallback(update);
      };
      callbackId = video.requestVideoFrameCallback(update);
      return () => { active = false; video.cancelVideoFrameCallback(callbackId); };
    }
    const update = () => {
      if (!active) return;
      setTime(video.currentTime);
      callbackId = requestAnimationFrame(update);
    };
    callbackId = requestAnimationFrame(update);
    return () => { active = false; cancelAnimationFrame(callbackId); };
  }, [asset?.url]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsed((performance.now() - startRef.current) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas && context) drawSkeleton(context, current, { width: canvas.width, height: canvas.height, raw, showFace, showHands });
  }, [current, raw, showFace, showHands, asset]);

  async function importFile(file: File) {
    if (busy) return;
    if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
      setError('Choose an MP4, WebM, or MOV video. Codec support depends on your browser.');
      return;
    }
    if (file.size > MAX_SIZE) { setError('The prototype supports files up to 250 MB. Choose a smaller clip.'); return; }
    const run = ++runRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setMediaLoading(true);
    setError('');
    const url = URL.createObjectURL(file);
    try {
      const meta = await loadVideoMetadata(url, controller.signal);
      if (run !== runRef.current) { URL.revokeObjectURL(url); return; }
      if (!Number.isFinite(meta.duration) || meta.duration <= 0 || meta.duration > MAX_DURATION) {
        throw new Error('Choose a video with a duration greater than zero and no longer than 60 seconds.');
      }
      videoRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setAsset({ ...meta, url, name: file.name, size: file.size });
      setFrames([]);
      setReferenceTimestamp(undefined);
      setTime(0);
      setPlaying(false);
      setElapsed(0);
      setPhase('idle');
    } catch (cause) {
      URL.revokeObjectURL(url);
      if (run === runRef.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open the video. Try an H.264 MP4 file.');
    } finally {
      if (run === runRef.current) setMediaLoading(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void importFile(file);
    event.target.value = '';
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void importFile(file);
  }

  function clearAnalysis() {
    setFrames([]);
    setReferenceTimestamp(undefined);
    setPhase('idle');
    setElapsed(0);
    setError('');
  }

  async function analyze() {
    if (!asset || busy || mediaLoading || !metricsAcknowledged) return;
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = 0;
    setPlaying(false);
    setTime(0);
    setFrames([]);
    setReferenceTimestamp(undefined);
    setError('');
    setElapsed(0);
    setPhase('loading-model');
    startRef.current = performance.now();
    const run = ++runRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const client = new MotionClient();
    clientRef.current = client;
    const collected: MotionFrame[] = [];
    let lastUpdate = 0;
    try {
      await client.initialize(smoothing);
      controller.signal.throwIfAborted();
      if (run !== runRef.current) return;
      setPhase('analyzing');
      await sampleVideo({
        url: asset.url, duration: asset.duration, fps, signal: controller.signal,
        onFrame: async (bitmap, timestampMs) => {
          const result = await client.processFrame(bitmap, timestampMs);
          controller.signal.throwIfAborted();
          collected.push(result);
          if (performance.now() - lastUpdate > 100) {
            if (run === runRef.current) setFrames([...collected]);
            lastUpdate = performance.now();
          }
        },
      });
      if (run === runRef.current) { setFrames([...collected]); setPhase('complete'); }
    } catch (cause) {
      if (run !== runRef.current) return;
      setFrames([...collected]);
      if (controller.signal.aborted) setPhase('cancelled');
      else {
        setPhase('error');
        setError(cause instanceof Error ? cause.message : 'Analysis failed. Check the model files and browser support, then try again.');
      }
    } finally {
      client.dispose();
      if (run === runRef.current) {
        clientRef.current = null;
        abortRef.current = null;
        setElapsed((performance.now() - startRef.current) / 1000);
      }
    }
  }

  function cancel() {
    abortRef.current?.abort();
    clientRef.current?.dispose();
  }

  function seek(seconds: number) {
    const video = videoRef.current;
    if (!video || !asset) return;
    video.currentTime = Math.max(0, Math.min(asset.duration, seconds));
    setTime(video.currentTime);
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try { await video.play(); } catch { setError('Could not play the video in this browser. Try an H.264 MP4 file.'); }
    } else video.pause();
  }

  function downloadMotion() {
    const canonicalFrames = frames.flatMap(frame => frame.canonical ? [frame.canonical] : []);
    if (!asset || !canonicalFrames.length) return;
    const json = {
      format: 'motion2d-canonical', schemaVersion: 1,
      source: { name: asset.name, width: asset.width, height: asset.height, durationSeconds: asset.duration, analysisFps: fps },
      coordinates: { axes: 'x-right-y-down', angles: 'radians', rootUnit: 'source-image-height', jointUnit: 'reference-torso-length' },
      referenceTimestampMs: reference?.timestampMs, frames: canonicalFrames,
      analysis: { complete: phase === 'complete', analyzedUntilMs: canonicalFrames[canonicalFrames.length - 1].timestampMs, expectedSamples: total },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(json)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${asset.name.replace(/\.[^.]+$/, '')}.canonical.motion2d.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const qualityBins = Array.from({ length: Math.min(100, frames.length) }, (_, index) => {
    const from = Math.floor(index * frames.length / Math.min(100, frames.length));
    const to = Math.max(from + 1, Math.floor((index + 1) * frames.length / Math.min(100, frames.length)));
    const slice = frames.slice(from, to);
    return { timestampMs: frames[from].timestampMs, score: slice.reduce((sum, frame) => sum + frame.confidence, 0) / slice.length };
  });

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href={import.meta.env.BASE_URL} aria-label="MotionBridge home" dir="ltr">
        <svg width="31" height="31" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m5 25 7-17 8 16 7-17M5 25h22" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" /><circle cx="12" cy="8" r="3" fill="currentColor" /><circle cx="20" cy="24" r="3" fill="currentColor" /></svg>
        <span>motion<span className="brand-accent">bridge</span><span className="brand-dot">.</span></span>
      </a>
      <nav className="workflow" aria-label="Workflow"><a className={`step ${reference ? 'finished' : 'active'}`} href="#motion-source"><b>01</b> Capture motion</a><a className={`step ${reference ? 'active' : ''}`} href="#character-preview"><b>02</b> Animate character</a><span className="step" title="OpenToonz export is planned"><b>03</b> OpenToonz (planned)</span></nav>
      <div className="local-badge"><span className="status-dot" /> On-device processing <Icon name="shield" size={15} /></div>
    </header>

    <main>
      <section className="page-heading">
        <div><div className="eyebrow" dir="ltr">THE MOTION LAB <span>/</span> PROTOTYPE 02</div><h1>Real performance. Animated characters.</h1><p>Extract motion, calibrate a reference pose, and bring a PNG character to life.</p></div>
        <div className="milestone-chip"><span className="tiny-square" /> Experimental prototype <span dir="ltr">v0.2</span></div>
      </section>

      <div className="workspace">
        <aside className="sidebar">
          <section className="panel source-panel">
            <div className="panel-title"><span>01 <i>/</i> Motion source</span><span className="small-tag">VIDEO</span></div>
            <input ref={inputRef} className="sr-only" type="file" accept=".mp4,.webm,.mov,.m4v,video/mp4,video/webm,video/quicktime" onChange={onFileChange} disabled={busy || mediaLoading} aria-label="Choose a video" />
            <button className={`dropzone ${dragging ? 'dragging' : ''} ${asset ? 'has-file' : ''}`} disabled={busy || mediaLoading} onClick={() => inputRef.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              <span className="upload-icon"><Icon name={asset ? 'file' : 'upload'} size={25} /></span>
              <strong>{mediaLoading ? 'Reading video…' : asset ? 'Choose another video' : 'Drop a video here'}</strong>
              <span>{asset ? 'or drop a new file' : 'or click to choose a file'}</span>
              <small dir="ltr">MP4 · WebM · MOV</small>
            </button>
            {asset ? <div className="file-info"><div className="file-name" dir="auto" title={asset.name}>{asset.name}</div><div className="file-meta" dir="ltr"><span>{asset.width} × {asset.height}</span><span>{formatTime(asset.duration)}</span><span>{(asset.size / 1024 / 1024).toFixed(1)} MB</span></div></div> : <p className="field-note">Up to 60 seconds · Maximum 250 MB</p>}
          </section>

          <section className="panel settings-panel">
            <div className="panel-title"><span>02 <i>/</i> Analysis settings</span></div>
            <label className="field-label" htmlFor="sample-rate">Sample rate <span>FPS</span></label>
            <div className="select-wrap"><select id="sample-rate" value={fps} disabled={busy} onChange={event => { setFps(Number(event.target.value)); clearAnalysis(); }}><option value={12}>12 samples / second</option><option value={24}>24 samples / second</option><option value={30}>30 samples / second</option></select></div>
            <p className="field-note">Analysis sample rate; the source video frame rate is unchanged.</p>
            <div className="field-label">Motion smoothing <span>SMOOTHING</span></div>
            <div className="segmented" role="group" aria-label="Motion smoothing">{(Object.keys(presets) as SmoothingPreset[]).map(preset => <button key={preset} className={smoothing === preset ? 'selected' : ''} aria-pressed={smoothing === preset} disabled={busy} onClick={() => { setSmoothing(preset); clearAnalysis(); }}>{presets[preset]}</button>)}</div>
            <p className="field-note">Balanced smoothing reduces jitter while preserving movement.</p>
            <div className="analysis-targets"><span><i /> Body</span><span><i /> Face</span><span><i /> Hands</span></div>
            <label className="metrics-consent"><input type="checkbox" checked={metricsAcknowledged} disabled={busy} onChange={event => setMetricsAcknowledged(event.target.checked)} /><span>I agree to MediaPipe sending performance and usage metrics to Google. <a href="https://github.com/google-ai-edge/mediapipe#privacy-notice" target="_blank" rel="noreferrer">Privacy notice</a></span></label>
            {busy ? <button className="analyze-button cancel" onClick={cancel}><Icon name="close" size={18} /> Cancel analysis</button> : <button className="analyze-button" disabled={!asset || mediaLoading || !metricsAcknowledged} onClick={() => void analyze()}><span>{frames.length ? 'Analyze again' : 'Analyze motion'}</span><Icon name="arrow" size={19} /></button>}
            <div className="privacy-note"><Icon name="shield" size={16} /><span>Your video stays on your device.</span></div>
          </section>
          <div className="capture-tip"><span className="tip-index">TIP / 01</span><p>For clearer tracking, use good lighting and one person with their full body visible.</p></div>
        </aside>

        <div className="editor-column">
          <section id="motion-source" className="panel preview-panel">
            <div className="preview-header"><div className="panel-title"><span>Source preview</span><span className={`preview-state ${asset ? 'ready' : ''}`}><span className="status-dot" />{asset ? 'Ready to review' : 'No video selected'}</span></div><div className="view-switch" role="group" aria-label="Motion view"><button aria-pressed={!raw} className={!raw ? 'selected' : ''} onClick={() => setRaw(false)}>Cleaned</button><button aria-pressed={raw} className={raw ? 'selected' : ''} onClick={() => setRaw(true)}>Raw</button></div></div>
            <div ref={viewportRef} className={`viewport ${asset ? 'with-video' : ''}`}>
              {asset ? <div className="media-plane" style={{ aspectRatio: `${asset.width}/${asset.height}`, width: Math.min(viewportSize.width, viewportSize.height * asset.width / asset.height) }}>
                <video ref={videoRef} src={asset.url} playsInline preload="auto" onTimeUpdate={event => setTime(event.currentTarget.currentTime)} onSeeked={event => setTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setError('Could not decode the video. Try an H.264 MP4 file.')} />
                <canvas ref={canvasRef} width={Math.round(Math.min(asset.width, 1280))} height={Math.round(Math.min(asset.width, 1280) * asset.height / asset.width)} aria-label="Extracted skeleton over the source video" />
              </div> : <div className="empty-preview"><div className="skeleton-illustration"><SkeletonMark /><span className="tracking-corner top-left" /><span className="tracking-corner bottom-right" /></div><h2>Start with a performance</h2><p>Add a video and analyze its motion to see tracking landmarks.</p><span className="empty-caption" dir="ltr">HUMAN PERFORMANCE → MOTION DATA</span></div>}
              <div className="viewport-corner" dir="ltr"><span className="crosshair">+</span> {asset ? `${asset.width} × ${asset.height}` : 'SOURCE VIEW'}</div>
              {current && <div className="tracking-badge"><span className={`status-dot ${current.confidence < .45 ? 'warning' : ''}`} />{current.raw.pose.length ? `Body confidence ${Math.round(current.confidence * 100)}%` : 'Body not visible'}</div>}
            </div>
            <div className="transport" dir="ltr"><div className="play-controls"><button aria-label="Previous sample" title={`Step back by 1/${fps} second`} disabled={!asset} onClick={() => seek(time - 1 / fps)}><Icon name="back" size={17} /></button><button className="play-button" aria-label={playing ? 'Pause video' : 'Play video'} disabled={!asset} onClick={() => void togglePlayback()}><Icon name={playing ? 'pause' : 'play'} size={18} /></button><button aria-label="Next sample" title={`Step forward by 1/${fps} second`} disabled={!asset} onClick={() => seek(time + 1 / fps)}><Icon name="forward" size={17} /></button></div><span className="timecode">{formatTime(time)} <span>/ {formatTime(asset?.duration ?? 0)}</span></span><input className="seek-bar" type="range" aria-label="Video position" min="0" max={asset?.duration ?? 1} step="0.001" value={time} disabled={!asset} onChange={event => seek(Number(event.target.value))} /><span className="frame-number">SAMPLE {asset ? Math.min(Math.floor(time * fps) + 1, total).toString().padStart(4, '0') : '—'}</span></div>
            <div className="overlay-options"><span className="overlay-label">Tracking overlays</span><span className="legend body"><i /> Body</span><label><input type="checkbox" checked={showHands} onChange={event => setShowHands(event.target.checked)} /><span className="legend hands"><i /> Hands</span></label><label><input type="checkbox" checked={showFace} onChange={event => setShowFace(event.target.checked)} /><span className="legend face"><i /> Face</span></label><span className="overlay-note">{frames.length ? 'Compare raw and cleaned motion' : 'Available after analysis'}</span></div>
          </section>

          <section className="panel timeline-panel">
            <div className="timeline-heading"><div className="panel-title"><span>Tracking quality</span><span className="small-tag">BODY CONFIDENCE</span></div><span className="timeline-hint">{frames.length ? 'Click to seek to a sample' : 'Waiting for analysis'}</span></div>
            <div className="quality-track" dir="ltr" aria-label="Body tracking quality">{qualityBins.length ? <div className="quality-coverage" style={{ width: `${analyzedCoverage}%` }}>{qualityBins.map((bin, index) => <button key={index} className={`quality-bin ${bin.score >= .7 ? 'good' : bin.score >= .45 ? 'medium' : 'low'}`} style={{ height: `${28 + bin.score * 58}%` }} aria-label={`Sample at ${formatTime(bin.timestampMs / 1000)}, confidence ${Math.round(bin.score * 100)} percent`} title={`${formatTime(bin.timestampMs / 1000)} · ${Math.round(bin.score * 100)}%`} onClick={() => seek(bin.timestampMs / 1000)} />)}</div> : <div className="empty-track">{Array.from({ length: 72 }, (_, index) => <i key={index} style={{ height: `${18 + ((index * 17) % 23)}%` }} />)}</div>}</div>
            <div className="timeline-scale" dir="ltr"><span>00:00</span><span>{asset ? formatTime(asset.duration / 2) : '—'}</span><span>{asset ? formatTime(asset.duration) : '—'}</span></div>
          </section>

          <section className={`analysis-status ${busy ? 'is-busy' : ''}`} aria-live="polite" role="status"><div className="status-description"><span className={`status-symbol ${phase === 'complete' ? 'done' : ''}`}>{busy ? <span className="spinner" /> : phase === 'complete' ? <Icon name="check" size={19} /> : <span>↳</span>}</span><div><strong>{asset && phase === 'idle' ? 'Video ready. Start motion analysis.' : phaseLabels[phase]}</strong><p>{phase === 'loading-model' ? 'Loading the local model and preparing the engine…' : phase === 'analyzing' ? `${frames.length} of ${total} samples · analyzed sections are ready to review` : phase === 'complete' ? 'Review the tracking and compare raw and cleaned motion.' : phase === 'cancelled' ? 'Analyzed samples were kept for review. You can start again.' : 'Motion inference runs in your browser.'}</p></div></div><div className="status-metrics" dir="ltr"><div><strong>{frames.length ? `${detectionRate}%` : '—'}</strong><span>Confident body samples</span></div><div><strong>{averageMs ? `${averageMs} ms` : '—'}</strong><span>Inference / sample</span></div><div><strong>{elapsed ? `${elapsed.toFixed(1)} s` : '—'}</strong><span>Elapsed time</span></div></div>{(busy || frames.length > 0) && <div className="progress-line" role="progressbar" aria-label="Analysis progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>}</section>
          <section className="canonical-toolbar" aria-label="Motion calibration">
            <div><strong>Motion reference pose</strong><p>{reference ? `Reference at ${formatTime(reference.timestampMs / 1000)} · ${referenceIncomplete ? 'Some joints are unclear; choose a better frame to calibrate.' : 'Choose a neutral pose and set it as the reference.'}` : 'A clear frame will be selected as the reference after analysis.'}</p></div>
            <button disabled={!current?.canonical?.valid || busy} onClick={() => setReferenceTimestamp(current!.timestampMs)}>Use current frame as reference</button>
            <button disabled={!reference || busy} onClick={downloadMotion}>Save motion JSON</button>
          </section>
          <div id="character-preview">
            <CharacterPreview motion={current?.canonical} reference={reference} onError={setError} />
            <div className="character-playback">
              <div className="transport" dir="ltr">
                <div className="play-controls">
                  <button aria-label="Previous character sample" disabled={!asset} onClick={() => seek(time - 1 / fps)}><Icon name="back" size={17} /></button>
                  <button className="play-button" aria-label={playing ? 'Pause character preview' : 'Play character preview'} disabled={!asset} onClick={() => void togglePlayback()}><Icon name={playing ? 'pause' : 'play'} size={18} /></button>
                  <button aria-label="Next character sample" disabled={!asset} onClick={() => seek(time + 1 / fps)}><Icon name="forward" size={17} /></button>
                </div>
                <span className="timecode">{formatTime(time)} <span>/ {formatTime(asset?.duration ?? 0)}</span></span>
                <input className="seek-bar" type="range" aria-label="Character motion position" min="0" max={asset?.duration ?? 1} step="0.001" value={time} disabled={!asset} onChange={event => seek(Number(event.target.value))} />
                <span className="frame-number">SYNCED TO SOURCE</span>
              </div>
            </div>
          </div>
          {error && <div className="error-message" role="alert"><strong>Could not complete the operation</strong><p>{error}</p><button onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}
        </div>
      </div>
      <footer><span dir="ltr">MOTIONBRIDGE <i> / </i> MADE FOR THE MOVEMENT.</span><span>Up next: foot locking and motion correction <span aria-hidden="true">↖</span></span></footer>
    </main>
  </div>;
}
