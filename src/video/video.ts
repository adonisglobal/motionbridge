import type { MotionFrame } from '../tracking/types.ts';

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
}

export interface SampleVideoOptions {
  url: string;
  duration: number;
  /** Analysis frequency, independent of the source video's frame rate. */
  fps: number;
  signal?: AbortSignal;
  /** Ownership of the bitmap passes to this callback, including on failure. */
  onFrame: (bitmap: ImageBitmap, timestampMs: number) => Promise<void>;
}

const MEDIA_TIMEOUT_MS = 15_000;
const MAX_ANALYSIS_EDGE = 640;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Video analysis was cancelled.', 'AbortError');
  }
}

function mediaError(video: HTMLVideoElement): Error {
  const details = video.error?.message;
  return new Error(
    `The browser could not decode this video. Try MP4 (H.264) or WebM.${details ? ` ${details}` : ''}`,
  );
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  event: 'loadedmetadata' | 'loadeddata' | 'seeked',
  signal?: AbortSignal,
  start?: () => void,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, onReady);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => fail(mediaError(video));
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        fail(error);
      }
    };
    video.addEventListener(event, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => fail(new Error(`Video ${event === 'seeked' ? 'seeking' : 'loading'} timed out. Try another video.`)),
      MEDIA_TIMEOUT_MS,
    );
    try {
      start?.();
      if (video.error) onError();
    } catch (error) {
      fail(error);
    }
  });
}

function releaseVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  // Explicitly releases the decoder and any pending network/blob reads.
  video.load();
}

async function openVideo(url: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  throwIfAborted(signal);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  try {
    await waitForVideoEvent(video, 'loadedmetadata', signal, () => {
      video.src = url;
      video.load();
    });
    if (
      !Number.isFinite(video.duration) || video.duration <= 0 ||
      video.videoWidth <= 0 || video.videoHeight <= 0
    ) {
      throw new Error('This video has no usable duration or image dimensions. Try another video.');
    }
    return video;
  } catch (error) {
    releaseVideo(video);
    throw error;
  }
}

export async function loadVideoMetadata(url: string, signal?: AbortSignal): Promise<VideoMetadata> {
  const video = await openVideo(url, signal);
  try {
    throwIfAborted(signal);
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  } finally {
    releaseVideo(video);
  }
}

/** Fixed timestamps in milliseconds. The unseekable duration endpoint is excluded. */
export function createSampleTimes(duration: number, fps: number): number[] {
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError('Video duration must be a finite, non-negative number.');
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError('Analysis FPS must be a finite, positive number.');
  }
  const times: number[] = [];
  const count = Math.ceil(duration * fps);
  if (!Number.isSafeInteger(count)) throw new RangeError('The requested sample count is too large.');
  for (let index = 0; index < count; index += 1) {
    const timestampMs = index * 1000 / fps;
    if (timestampMs < duration * 1000) times.push(timestampMs);
  }
  return times;
}

async function seekFrame(video: HTMLVideoElement, seconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (Math.abs(video.currentTime - seconds) > 0.000001) {
    await waitForVideoEvent(video, 'seeked', signal, () => { video.currentTime = seconds; });
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForVideoEvent(video, 'loadeddata', signal);
  }
  throwIfAborted(signal);
}

/**
 * Uses its own paused decoder, so analysis never seeks or pauses the visible player.
 * Only one resized image is in flight; the callback must finish before the next seek.
 */
export async function sampleVideo({ url, duration, fps, signal, onFrame }: SampleVideoOptions): Promise<void> {
  const requestedTimes = createSampleTimes(duration, fps);
  throwIfAborted(signal);
  if (requestedTimes.length === 0) return;
  const video = await openVideo(url, signal);
  const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const resizeWidth = Math.max(1, Math.round(video.videoWidth * scale));
  const resizeHeight = Math.max(1, Math.round(video.videoHeight * scale));
  try {
    for (const timestampMs of requestedTimes) {
      throwIfAborted(signal);
      if (timestampMs / 1000 >= video.duration) break;
      await seekFrame(video, timestampMs / 1000, signal);
      let bitmap: ImageBitmap | undefined;
      try {
        bitmap = await createImageBitmap(video, { resizeWidth, resizeHeight, resizeQuality: 'medium' });
        throwIfAborted(signal);
        const transferredBitmap = bitmap;
        bitmap = undefined;
        await onFrame(transferredBitmap, timestampMs);
        throwIfAborted(signal);
      } finally {
        // Once handed off, the callback/worker owns disposal. Before that, we do.
        bitmap?.close();
      }
    }
  } finally {
    releaseVideo(video);
  }
}

/** Nearest analyzed frame, without extending a partial result across the rest of a clip. */
export function findMotionFrame(frames: MotionFrame[], timeSeconds: number): MotionFrame | undefined {
  if (frames.length === 0 || !Number.isFinite(timeSeconds) || timeSeconds < 0) return undefined;
  const timeMs = timeSeconds * 1000;
  const first = frames[0];
  const last = frames[frames.length - 1];
  // One frame has no measurable cadence; use a conservative half-frame at 60 Hz.
  const firstStep = frames.length > 1 ? frames[1].timestampMs - first.timestampMs : 1000 / 60;
  const lastStep = frames.length > 1 ? last.timestampMs - frames[frames.length - 2].timestampMs : 1000 / 60;
  const maxStep = 1000 / 12;
  const before = Math.max(0, Math.min(firstStep, maxStep)) / 2;
  const after = Math.max(0, Math.min(lastStep, maxStep)) / 2;
  if (timeMs < first.timestampMs - before || timeMs > last.timestampMs + after) return undefined;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].timestampMs < timeMs) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return first;
  const previous = frames[low - 1];
  const next = frames[low];
  return timeMs - previous.timestampMs <= next.timestampMs - timeMs ? previous : next;
}
