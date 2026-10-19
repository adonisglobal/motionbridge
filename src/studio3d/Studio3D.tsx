import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMotionStudio3D } from './useMotionStudio3D';
import { findMotionFrame } from '../video/video';
import { drawSkeleton } from '../ui/skeleton';
import { chooseReference3D } from '../motion3d/solver';
import { CharacterPreview3D } from '../ui3d/CharacterPreview3D';
import { exportMotionBVH, buildMotion3DJSON } from '../export3d';
import type { SmoothingPreset } from '../tracking/types';
import type { Skeleton3D } from '../motion3d/types';

const labels = { idle: 'Ready for a performance', loading: 'Preparing the motion model', analyzing: 'Extracting 3D motion', complete: 'Analysis complete', cancelled: 'Analysis cancelled', error: 'Analysis stopped' };
function clock(value: number) {
  return `${Math.floor(value / 60).toString().padStart(2,'0')}:${(Math.max(0,value) % 60).toFixed(2).padStart(5,'0')}`;
}
function saveFile(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export default function Studio3D({ active }: { active: boolean }) {
  const studio = useMotionStudio3D(active);
  const { source, samples, time, busy, fps, phase } = studio;
  const [referenceTime, setReferenceTime] = useState<number>();
  const [strength, setStrength] = useState(1);
  const [inPlace, setInPlace] = useState(true);
  const [calibration, setCalibration] = useState<'anatomical' | 'reference'>('anatomical');
  const [raw, setRaw] = useState(false);
  const [exportFps, setExportFps] = useState(24);
  const [allowUncertain, setAllowUncertain] = useState(false);
  const [exportNote, setExportNote] = useState('');
  const [exportStart, setExportStart] = useState(0);
  const [exportEnd, setExportEnd] = useState<number>();
  const [targetSkeleton, setTargetSkeleton] = useState<Skeleton3D>();
  const onSkeletonChange = useCallback((skeleton: Skeleton3D | undefined) => setTargetSkeleton(skeleton), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaHost = useRef<HTMLDivElement>(null);
  const [mediaWidth, setMediaWidth] = useState(280);
  const motionFrames = useMemo(() => samples.map(sample => sample.motion), [samples]);
  const trackingFrames = useMemo(() => samples.map(sample => sample.tracking), [samples]);
  const lastTracking = trackingFrames[trackingFrames.length - 1];
  const currentTracking = phase === 'complete' && source && lastTracking && time >= lastTracking.timestampMs / 1000 && time <= source.duration
    ? lastTracking : findMotionFrame(trackingFrames, time);
  const current = currentTracking ? samples.find(sample => sample.motion.timestampMs === currentTracking.timestampMs)?.motion : undefined;
  const reference = useMemo(() => referenceTime === undefined ? chooseReference3D(motionFrames) : motionFrames.find(frame => frame.timestampMs === referenceTime), [motionFrames, referenceTime]);
  const percent = studio.expectedSamples ? Math.min(100, Math.round(samples.length / studio.expectedSamples * 100)) : 0;
  const valid = motionFrames.filter(frame => frame.valid).length;
  const review = motionFrames.filter(frame => frame.needsReview || !frame.valid).length;
  const analyzedUntil = source && lastTracking ? Math.min(source.duration, lastTracking.timestampMs / 1000 + 1 / fps) : 0;
  const partial = samples.length > 0 && phase !== 'complete';
  const exportFrames = useMemo(() => motionFrames.filter(frame => frame.timestampMs >= exportStart * 1000 - .001 && (exportEnd === undefined || frame.timestampMs <= exportEnd * 1000 + .001)), [motionFrames, exportStart, exportEnd]);

  useEffect(() => { if (!samples.length) { setReferenceTime(undefined); setExportNote(''); setExportStart(0); setExportEnd(undefined); } }, [samples.length]);
  useEffect(() => { setReferenceTime(undefined); setExportNote(''); setExportStart(0); setExportEnd(undefined); }, [source]);
  useEffect(() => {
    const host = mediaHost.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setMediaWidth(entry.contentRect.width));
    observer.observe(host); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) drawSkeleton(ctx, currentTracking, { width: canvas.width, height: canvas.height, raw, showFace: true, showHands: true });
  }, [currentTracking, raw, source]);

  function exportMotion(format: 'bvh' | 'json') {
    if (!reference || !source) return;
    if (!exportFrames.length) { studio.setError('The selected export range has no analyzed samples. Choose a range within the capture.'); return; }
    try {
      const options = { frames: exportFrames, reference, fps: exportFps, strength, inPlace, allowUncertain, skeleton: targetSkeleton, calibration };
      const name = source.name.replace(/\.[^.]+$/, '');
      if (format === 'bvh') {
        const result = exportMotionBVH(options);
        saveFile(result.text, `${name}.motion3d.bvh`, 'text/plain');
        setExportNote(`${result.frameCount} frames at ${result.fps} FPS. ${partial ? `Partial capture: ${clock(result.sourceStartMs / 1000)}–${clock(result.sourceEndMs / 1000)} of ${clock(source.duration)}. ` : ''}${result.warnings.join(' ')}`);
      } else {
        const data = buildMotion3DJSON({ ...options, source: { name: source.name, kind: source.kind, width: source.width, height: source.height, durationSeconds: source.duration, analysisFps: fps, analysisComplete: phase === 'complete', analyzedUntilSeconds: analyzedUntil } });
        saveFile(JSON.stringify(data), `${name}.motion3d.json`, 'application/json');
        setExportNote('Saved 3D motion, confidence, calibration, and coordinate metadata.');
      }
    } catch (cause) { studio.setError(cause instanceof Error ? cause.message : 'Could not export 3D motion.'); }
  }

  return <div className="studio3d">
    <header className="motion3d-header">
      <a className="brand" href={import.meta.env.BASE_URL} aria-label="Motion workspace home"><span>motion<span className="brand-accent">2d</span><span className="brand-dot">.</span></span><span className="motion3d-brand-tag">3D STUDIO</span></a>
      <span className="motion3d-local"><i /> ON-DEVICE INFERENCE</span>
    </header>
    <main className="motion3d-main">
      <div className="motion3d-heading"><div><div className="eyebrow">PERFORMANCE → MOTION → BLENDER</div><h1>Give your character a performance.</h1><p>Capture body motion. Calibrate the pose. Preview it in 3D and take it into Blender.</p><a className="motion3d-jump" href="#motion3d-character">View character ↓</a></div><span className="motion3d-prototype">3D workspace <b>EXPERIMENTAL</b></span></div>
      <div className="motion3d-layout">
        <aside className="motion3d-sidebar">
          <section className="motion3d-card">
            <h2><span>01 /</span> Source performance</h2>
            <input ref={studio.inputRef} className="sr-only" type="file" accept=".mp4,.webm,.mov,.m4v,video/mp4,video/webm,video/quicktime" aria-label="Choose a 3D source video" disabled={busy || studio.loadingFile} onChange={studio.onFileChange} />
            <button className="motion3d-drop" disabled={busy || studio.loadingFile} onClick={() => studio.inputRef.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void studio.importVideo(file); }}>
              <span className="motion3d-upload">↥</span><strong>{studio.loadingFile ? 'Reading video…' : source ? 'Replace source video' : 'Choose or drop a video'}</strong><small>MP4 · WebM · MOV · up to 60 s / 250 MB</small>
            </button>
            <button className="motion3d-demo" disabled={busy || studio.loadingFile} onClick={studio.loadDemo}>Try built-in motion</button>
            {source && <><p className="motion3d-filename" title={source.name}>{source.name}</p><div className="motion3d-filemeta"><span>{source.width} × {source.height}</span><span>{clock(source.duration)}</span><span>{(source.size / 1024 / 1024).toFixed(1)} MB</span></div></>}
            <div className="motion3d-source" ref={mediaHost}>
              {source ? <div className="motion3d-source-plane" style={{ width: Math.min(mediaWidth, 240 * source.width / source.height), aspectRatio: `${source.width}/${source.height}` }}>
                {source.kind === 'video' && <video ref={studio.videoRef} src={source.url} muted playsInline preload="auto" onTimeUpdate={event => studio.setTime(event.currentTarget.currentTime)} onSeeked={event => studio.setTime(event.currentTarget.currentTime)} onPlay={() => studio.setPlaying(true)} onPause={() => studio.setPlaying(false)} onEnded={() => studio.setPlaying(false)} onError={() => studio.setError('Could not decode the source video. Try an H.264 MP4 file.')} />}
                <canvas ref={canvasRef} width={Math.min(source.width,1280)} height={Math.round(Math.min(source.width,1280) * source.height / source.width)} aria-label="3D source video tracking overlay" />
              </div> : <div className="motion3d-source-empty">A clear view of one whole body<br /><span>works best for motion tracking.</span></div>}
            </div>
            {source?.kind === 'demo' && <p className="motion3d-help">Generated example · exercises 3D motion and export without video inference.</p>}
            <div className="motion3d-source-switch" role="group" aria-label="3D source overlay"><button className={!raw ? 'selected' : ''} aria-pressed={!raw} onClick={() => setRaw(false)}>Cleaned</button><button className={raw ? 'selected' : ''} aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button></div>
          </section>
          <section className="motion3d-card motion3d-settings">
            <h2><span>02 /</span> Capture settings</h2>
            <label htmlFor="motion3d-sampling">Analysis sample rate</label>
            <select id="motion3d-sampling" disabled={busy || source?.kind === 'demo'} value={fps} onChange={event => { studio.setFps(Number(event.target.value)); studio.clearAnalysis(); }}><option value={12}>12 samples / second</option><option value={24}>24 samples / second</option><option value={30}>30 samples / second</option></select>
            <label htmlFor="motion3d-smoothing">Motion smoothing</label>
            <select id="motion3d-smoothing" disabled={busy || source?.kind === 'demo'} value={studio.smoothing} onChange={event => { studio.setSmoothing(event.target.value as SmoothingPreset); studio.clearAnalysis(); }}><option value="raw">Raw</option><option value="light">Light</option><option value="balanced">Balanced</option><option value="smooth">Smooth</option></select>
            <p className="motion3d-help">Sampling follows time. It does not change the original video frame rate.</p>
            <label className="motion3d-check motion3d-privacy"><input type="checkbox" checked={studio.acknowledged} disabled={busy} onChange={event => studio.setAcknowledged(event.target.checked)} /><span>I agree to MediaPipe sending performance and usage metrics to Google. <a href="https://github.com/google-ai-edge/mediapipe#privacy-notice" target="_blank" rel="noreferrer">Privacy notice</a></span></label>
            <button className="motion3d-primary" disabled={!busy && (!source || source.kind === 'demo' || studio.loadingFile || !studio.acknowledged)} onClick={() => busy ? studio.cancel() : void studio.analyze()}>{busy ? 'Cancel 3D analysis' : samples.length ? 'Analyze 3D motion again' : 'Analyze 3D motion'} <span>{busy ? '×' : '→'}</span></button>
            <p className="motion3d-help">Your video stays on this device.</p>
          </section>
        </aside>
        <div className="motion3d-editor">
          <div id="motion3d-character"><CharacterPreview3D frame={current ?? null} reference={reference ?? null} frames={exportFrames} analysisFps={exportFps} exportName={source?.name.replace(/\.[^.]+$/, '')} allowUncertain={allowUncertain} calibration={calibration} strength={strength} inPlace={inPlace} active={active} captureBusy={busy} onSkeletonChange={onSkeletonChange} /></div>
          <section className="motion3d-card motion3d-transport" aria-label="3D playback">
            <div className="motion3d-play-buttons"><button aria-label="Previous 3D sample" disabled={!source} onClick={() => studio.seek(time - 1 / fps)}>⏮</button><button className="motion3d-play" aria-label={studio.playing ? 'Pause 3D performance' : 'Play 3D performance'} disabled={!source} onClick={() => void studio.togglePlayback()}>{studio.playing ? 'Ⅱ' : '▶'}</button><button aria-label="Next 3D sample" disabled={!source} onClick={() => studio.seek(time + 1 / fps)}>⏭</button></div>
            <span>{clock(time)} <i>/ {clock(source?.duration ?? 0)}</i></span>
            <input type="range" aria-label="3D performance position" min="0" max={source?.duration ?? 1} step=".001" value={time} disabled={!source} onChange={event => studio.seek(Number(event.target.value))} /><small>SOURCE + CHARACTER</small>
          </section>
          <section className="motion3d-card motion3d-analysis" role="status" aria-live="polite">
            <div><strong>{source?.kind === 'demo' ? 'Generated motion example' : labels[phase]}</strong><p>{samples.length ? `${samples.length} / ${studio.expectedSamples} samples · ${valid} tracked · ${review} to review${partial ? ` · partial coverage through ${clock(analyzedUntil)}` : ''}` : 'Import a performance, then analyze its body motion.'}</p></div><span>{busy ? `${percent}%` : studio.elapsed ? `${studio.elapsed.toFixed(1)} s` : '—'}</span>
            {(busy || samples.length > 0) && <progress value={percent} max="100" aria-label="3D analysis progress" />}
          </section>
          {motionFrames.length > 0 && <section className="motion3d-quality" aria-label="3D tracking quality"><span>TRACKING QUALITY</span><div>{Array.from({length:Math.min(80,motionFrames.length)},(_,index) => {
            const frame = motionFrames[Math.floor(index * motionFrames.length / Math.min(80,motionFrames.length))];
            return <button key={index} className={!frame.valid ? 'invalid' : frame.needsReview ? 'review' : 'good'} title={`${clock(frame.timestampMs/1000)} · ${frame.valid ? frame.needsReview ? 'Review' : 'Tracked' : 'Missing tracking'}`} aria-label={`Review 3D sample at ${clock(frame.timestampMs/1000)}`} onClick={() => studio.seek(frame.timestampMs/1000)} />;
          })}</div></section>}
          <section className="motion3d-card motion3d-calibration">
            <div><h2><span>03 /</span> Motion calibration</h2><p>{reference ? `Reference at ${clock(reference.timestampMs / 1000)}${reference.needsReview ? ' · some joints need review' : ''}` : 'A clear tracked frame will be chosen automatically.'}</p></div>
            <button disabled={!current?.valid || busy} onClick={() => setReferenceTime(current!.timestampMs)}>Set current 3D reference</button>
            <label className="motion3d-calibration-mode" htmlFor="motion3d-calibration-mode">Pose mapping<select id="motion3d-calibration-mode" value={calibration} onChange={event => setCalibration(event.target.value as 'anatomical' | 'reference')}><option value="anatomical">Follow captured body pose</option><option value="reference">Map reference to model bind pose</option></select></label>
            <p className="motion3d-help motion3d-wide">{calibration === 'anatomical' ? 'Follows the captured limb directions. The reference calibrates body facing and the starting position.' : 'The selected source pose becomes the model bind pose. Choose a source frame that matches the model’s T-pose or A-pose.'}</p>
            <label className="motion3d-strength" htmlFor="motion3d-strength">Motion strength <output>{strength.toFixed(2)}×</output><input id="motion3d-strength" aria-label="3D motion strength" type="range" min="0" max="2" step=".05" value={strength} onChange={event => setStrength(Number(event.target.value))} /></label>
            <label className="motion3d-check"><input type="checkbox" checked={inPlace} onChange={event => setInPlace(event.target.checked)} /> In-place motion</label>
            <p className="motion3d-help motion3d-wide">In-place motion locks horizontal travel and keeps vertical body movement for squats and jumps.</p>
            <p className="motion3d-help motion3d-wide">Depth is estimated from one camera. Global movement uses the video's horizontal and vertical motion; camera travel and absolute depth are not measured.</p>
          </section>
          <section className="motion3d-card motion3d-export">
            <div><h2><span>04 /</span> Take it into Blender</h2><p>BVH contains an animated humanoid skeleton. Match its bones to your character in Blender.</p></div>
            <label htmlFor="motion3d-export-fps">Output FPS<select id="motion3d-export-fps" value={exportFps} onChange={event => setExportFps(Number(event.target.value))}><option value={24}>24</option><option value={30}>30</option><option value={60}>60</option></select></label>
            <label className="motion3d-check"><input type="checkbox" checked={allowUncertain} onChange={event => setAllowUncertain(event.target.checked)} /> Include frames marked for review</label>
            <div className="motion3d-export-range"><label htmlFor="motion3d-export-start">Start (seconds)<input id="motion3d-export-start" type="number" min="0" max={source?.duration ?? 0} step=".01" value={exportStart} onChange={event => setExportStart(Math.max(0, Number(event.target.value)))} /></label><label htmlFor="motion3d-export-end">End (seconds)<input id="motion3d-export-end" type="number" min={exportStart} max={source?.duration ?? 0} step=".01" value={exportEnd ?? Number(analyzedUntil.toFixed(3))} onChange={event => setExportEnd(event.target.value === '' ? undefined : Number(event.target.value))} /></label><span>{exportFrames.length} source samples selected</span></div>
            {partial && <p className="motion3d-help motion3d-wide">Partial capture: exports contain only analyzed samples through {clock(analyzedUntil)} of {clock(source?.duration ?? 0)}. Missing observations must be excluded with the export range.</p>}
            <div className="motion3d-export-actions"><button className="motion3d-primary" disabled={!reference || busy} onClick={() => exportMotion('bvh')}>Download Blender BVH</button><button disabled={!reference || busy} onClick={() => exportMotion('json')}>Save 3D motion JSON</button></div>
            {exportNote && <p className="motion3d-help motion3d-wide" role="status">{exportNote}</p>}
            <p className="motion3d-help motion3d-wide">Import in Blender: File → Import → Motion Capture (.bvh). Use Y Up, −Z Forward, and update the scene FPS.</p>
          </section>
          {studio.error && <div className="motion3d-error" role="alert"><div><strong>Action needs attention</strong><p>{studio.error}</p></div><button aria-label="Dismiss 3D error" onClick={() => studio.setError('')}>×</button></div>}
        </div>
      </div>
      <div className="motion3d-footer"><span>BODY MOTION / SPATIAL ROTATIONS / BLENDER BVH</span><span>Your 2D workspace keeps its own video, rig, and settings.</span></div>
    </main>
  </div>;
}
