import type { MotionFrame, MotionWorkerRequest, MotionWorkerResponse, SmoothingPreset } from './types.ts';

interface PendingRequest {
  resolve: (response: MotionWorkerResponse) => void;
  reject: (reason: Error) => void;
}

/** Owns one worker and at most one in-flight frame. A new analysis gets a fresh client. */
export class MotionClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private ready = false;
  private frameInFlight = false;
  private lastTimestampMs = -Infinity;

  async initialize(smoothing: SmoothingPreset): Promise<void> {
    this.dispose();
    if (!['raw', 'light', 'balanced', 'smooth'].includes(smoothing)) {
      throw new Error('Unknown smoothing preset.');
    }
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      throw new Error('This browser needs Web Workers and OffscreenCanvas for local analysis.');
    }

    const worker = new Worker(new URL('../workers/motion.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<MotionWorkerResponse>) => {
      if (this.worker !== worker) return;
      const response = event.data;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (response.type === 'error') request.reject(new Error(response.message));
      else request.resolve(response);
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.fail(worker, new Error(event.message || 'The motion worker stopped unexpectedly.'));
    };
    worker.onmessageerror = () => {
      this.fail(worker, new Error('The browser could not read a motion worker response.'));
    };

    try {
      const response = await this.request({ type: 'initialize', id: this.nextId++, smoothing });
      if (this.worker !== worker) throw new DOMException('Analysis was cancelled.', 'AbortError');
      if (response.type !== 'ready') throw new Error('Unexpected worker initialization response.');
      this.ready = true;
    } catch (error) {
      if (this.worker === worker) this.dispose();
      throw error;
    }
  }

  /** Transfers ownership of bitmap; callers should await each frame before sending the next. */
  async processFrame(bitmap: ImageBitmap, timestampMs: number): Promise<MotionFrame> {
    const worker = this.worker;
    if (!worker || !this.ready) {
      bitmap.close();
      throw new Error('Initialize the motion worker before analyzing frames.');
    }
    if (this.frameInFlight) {
      bitmap.close();
      throw new Error('Wait for the previous frame before analyzing another frame.');
    }
    if (!Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs <= this.lastTimestampMs) {
      bitmap.close();
      throw new Error('Frame timestamps must be finite, non-negative, and strictly increasing.');
    }
    if (bitmap.width === 0 || bitmap.height === 0) {
      bitmap.close();
      throw new Error('The video frame is empty.');
    }

    this.frameInFlight = true;
    this.lastTimestampMs = timestampMs;
    try {
      const response = await this.request({ type: 'frame', id: this.nextId++, bitmap, timestampMs }, [bitmap]);
      if (response.type !== 'frame') throw new Error('Unexpected worker frame response.');
      return response.frame;
    } catch (error) {
      // Closing an already transferred ImageBitmap is safe; this also covers postMessage failures.
      bitmap.close();
      throw error;
    } finally {
      if (this.worker === worker) this.frameInFlight = false;
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.frameInFlight = false;
    this.lastTimestampMs = -Infinity;
    for (const request of this.pending.values()) {
      request.reject(new DOMException('Analysis was cancelled.', 'AbortError'));
    }
    this.pending.clear();
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = null;
    this.ready = false;
    this.frameInFlight = false;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private request(message: MotionWorkerRequest, transfer: Transferable[] = []): Promise<MotionWorkerResponse> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new DOMException('Analysis was cancelled.', 'AbortError'));
        return;
      }
      this.pending.set(message.id, { resolve, reject });
      try {
        worker.postMessage(message, transfer);
      } catch (error) {
        this.pending.delete(message.id);
        reject(error);
      }
    });
  }
}
