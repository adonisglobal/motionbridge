import type { CanonicalFrame, FootContacts, Vec2 } from './canonical.ts';

interface ContactState {
  timestampMs: number;
  point: Vec2;
  anchor: Vec2;
  stableSinceMs: number;
  samples: number;
}

/** Marks sustained low-velocity feet. It deliberately does not move the root or invent floor depth. */
export class FootContactDetector {
  private left: ContactState | undefined;
  private right: ContactState | undefined;

  reset(): void {
    this.left = undefined;
    this.right = undefined;
  }

  process(frame: CanonicalFrame): FootContacts {
    if (!frame.valid) {
      this.reset();
      return { left: false, right: false };
    }
    const left = this.observe(frame, 'left');
    const right = this.observe(frame, 'right');
    return { left, right };
  }

  private observe(frame: CanonicalFrame, side: 'left' | 'right'): boolean {
    const ankle = frame.joints[side === 'left' ? 'ankleL' : 'ankleR'];
    if (ankle.confidence < 0.5 || ankle.held || !Number.isFinite(frame.scale) || frame.scale <= 0) {
      this[side] = undefined;
      return false;
    }
    // Recover absolute motion; local ankle coordinates alone would mistake walking for contact.
    const point = { x: frame.root.x / frame.scale + ankle.x, y: frame.root.y / frame.scale + ankle.y };
    const previous = this[side];
    const elapsedMs = previous ? frame.timestampMs - previous.timestampMs : Infinity;
    if (!previous || elapsedMs <= 0 || elapsedMs > 250) {
      this[side] = { timestampMs: frame.timestampMs, point, anchor: point, stableSinceMs: frame.timestampMs, samples: 1 };
      return false;
    }
    const speed = Math.hypot(point.x - previous.point.x, point.y - previous.point.y) / (elapsedMs / 1000);
    const drift = Math.hypot(point.x - previous.anchor.x, point.y - previous.anchor.y);
    if (speed > 0.18 || drift > 0.025) {
      this[side] = { timestampMs: frame.timestampMs, point, anchor: point, stableSinceMs: frame.timestampMs, samples: 1 };
      return false;
    }
    const state = { ...previous, timestampMs: frame.timestampMs, point, samples: previous.samples + 1 };
    this[side] = state;
    return state.samples >= 3 && frame.timestampMs - state.stableSinceMs >= 100;
  }
}
