import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { MotionClient } from '../tracking/motion-client';
import type { MotionFrame, SmoothingPreset } from '../tracking/types';
import { createSampleTimes, loadVideoMetadata, sampleVideo } from '../video/video';
import { MotionSolver3D } from '../motion3d/solver';
import type { Motion3DFrame } from '../motion3d/types';
import { createDemo3D } from '../motion3d/demo';

export type AnalysisPhase = 'idle' | 'loading' | 'analyzing' | 'complete' | 'cancelled' | 'error';
export interface SourceVideo3D { url: string; name: string; width: number; height: number; duration: number; size: number; kind: 'video' | 'demo' }
export interface AnalysisSample3D { tracking: MotionFrame; motion: Motion3DFrame }

export function useMotionStudio3D(active: boolean) {
  const [source, setSource] = useState<SourceVideo3D>();
  const [samples, setSamples] = useState<AnalysisSample3D[]>([]);
  const [phase, setPhase] = useState<AnalysisPhase>('idle');
  const [loadingFile, setLoadingFile] = useState(false);
  const [fps, setFps] = useState(24);
  const [smoothing, setSmoothing] = useState<SmoothingPreset>('balanced');
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const client = useRef<MotionClient | null>(null);
  const abort = useRef<AbortController | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const sourceUrl = useRef('');
  const generation = useRef(0);
  const startedAt = useRef(0);
  const demoClock = useRef({ time: 0, started: 0 });
  const busy = phase === 'loading' || phase === 'analyzing';

  useEffect(() => () => {
    generation.current++;
    abort.current?.abort();
    loadAbort.current?.abort();
    client.current?.dispose();
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
  }, []);
  useEffect(() => { if (!active) { videoRef.current?.pause(); setPlaying(false); } }, [active]);
  useEffect(() => {
    if (source?.kind !== 'demo' || !playing || !active) return;
    let id = 0;
    const tick = () => {
      const next = Math.min(source.duration, demoClock.current.time + (performance.now() - demoClock.current.started) / 1000);
      setTime(next);
      if (next >= source.duration) setPlaying(false);
      else id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [source, playing, active]);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setElapsed((performance.now() - startedAt.current) / 1000), 250);
    return () => window.clearInterval(id);
  }, [busy]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !active) return;
    let alive = true;
    let id = 0;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (!alive) return;
        setTime(meta.mediaTime);
        id = video.requestVideoFrameCallback(tick);
      };
      id = video.requestVideoFrameCallback(tick);
      return () => { alive = false; video.cancelVideoFrameCallback(id); };
    }
    const tick = () => { if (alive) { setTime(video.currentTime); id = requestAnimationFrame(tick); } };
    id = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(id); };
  }, [source?.url, active]);

  function clearAnalysis() { setSamples([]); setPhase('idle'); setElapsed(0); setError(''); }
  async function importVideo(file: File) {
    if (busy) return;
    if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) { setError('Choose MP4, WebM, MOV, or M4V video. Codec support depends on your browser.'); return; }
    if (file.size > 250 * 1024 * 1024) { setError('Choose a video no larger than 250 MB.'); return; }
    const token = ++generation.current;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoadingFile(true); setError('');
    const url = URL.createObjectURL(file);
    try {
      const metadata = await loadVideoMetadata(url, controller.signal);
      if (generation.current !== token) { URL.revokeObjectURL(url); return; }
      if (metadata.duration > 60) throw new Error('Choose a video no longer than 60 seconds.');
      videoRef.current?.pause();
      if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
      sourceUrl.current = url;
      setSource({ ...metadata, url, name: file.name, size: file.size, kind: 'video' });
      setTime(0); setPlaying(false); clearAnalysis();
    } catch (cause) {
      URL.revokeObjectURL(url);
      if (!controller.signal.aborted && token === generation.current) setError(cause instanceof Error ? cause.message : 'Could not open the video.');
    } finally { if (token === generation.current) setLoadingFile(false); }
  }
  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void importVideo(file);
  }
  function loadDemo() {
    if (busy || loadingFile) return;
    generation.current++;
    loadAbort.current?.abort();
    videoRef.current?.pause();
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    sourceUrl.current = '';
    const demo = createDemo3D();
    setSource({ url: '', name: 'Built-in motion example', width: demo.width, height: demo.height, duration: demo.durationSeconds, size: 0, kind: 'demo' });
    setSamples(demo.motionFrames.map((motion, index) => ({ motion, tracking: demo.trackingFrames[index] })));
    setFps(demo.analysisFps); setPhase('complete'); setError(''); setTime(0); setPlaying(false); setElapsed(0);
  }
  async function analyze() {
    if (!source || source.kind === 'demo' || busy || loadingFile || !acknowledged) return;
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.currentTime = 0;
    setTime(0); setPlaying(false); setSamples([]); setError(''); setElapsed(0); setPhase('loading');
    startedAt.current = performance.now();
    const token = ++generation.current;
    const controller = new AbortController();
    abort.current = controller;
    const worker = new MotionClient(); client.current = worker;
    const solver = new MotionSolver3D({ aspectRatio: source.width / source.height });
    const collected: AnalysisSample3D[] = [];
    let lastUpdate = 0;
    try {
      await worker.initialize(smoothing);
      controller.signal.throwIfAborted();
      if (generation.current !== token) return;
      setPhase('analyzing');
      await sampleVideo({ url: source.url, duration: source.duration, fps, signal: controller.signal,
        onFrame: async (bitmap, timestampMs) => {
          const tracking = await worker.processFrame(bitmap, timestampMs);
          controller.signal.throwIfAborted();
          collected.push({ tracking, motion: solver.solve(tracking) });
          if (performance.now() - lastUpdate > 100) {
            if (token === generation.current) setSamples([...collected]);
            lastUpdate = performance.now();
          }
        },
      });
      if (token === generation.current) { setSamples([...collected]); setPhase('complete'); }
    } catch (cause) {
      if (token !== generation.current) return;
      setSamples([...collected]);
      setPhase(controller.signal.aborted ? 'cancelled' : 'error');
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not analyze the video.');
    } finally {
      worker.dispose();
      if (token === generation.current) { client.current = null; abort.current = null; setElapsed((performance.now() - startedAt.current) / 1000); }
    }
  }
  function cancel() { abort.current?.abort(); client.current?.dispose(); }
  function seek(seconds: number) {
    if (!source) return;
    const next = Math.min(source.duration, Math.max(0, seconds));
    if (source.kind === 'demo') demoClock.current = { time: next, started: performance.now() };
    else if (videoRef.current) videoRef.current.currentTime = next;
    setTime(next);
  }
  async function togglePlayback() {
    if (source?.kind === 'demo') {
      const next = time >= source.duration ? 0 : time;
      demoClock.current = { time: next, started: performance.now() };
      setTime(next); setPlaying(value => !value); return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try { await video.play(); } catch { setError('Playback failed. Try an H.264 MP4 video.'); }
    } else video.pause();
  }
  const expectedSamples = source ? createSampleTimes(source.duration, fps).length : 0;
  return { source, samples, phase, busy, loadingFile, fps, setFps, smoothing, setSmoothing, error, setError,
    time, playing, setPlaying, setTime, elapsed, acknowledged, setAcknowledged, videoRef, inputRef,
    importVideo, onFileChange, loadDemo, analyze, cancel, seek, togglePlayback, clearAnalysis, expectedSamples };
}
