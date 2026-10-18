import type { Landmark, LandmarkSet, SmoothingPreset } from '../tracking/types.ts';

interface FilterOptions {
  minCutoff: number;
  beta: number;
  derivativeCutoff: number;
}

const PRESETS: Record<Exclude<SmoothingPreset, 'raw'>, FilterOptions> = {
  light: { minCutoff: 2.0, beta: 0.12, derivativeCutoff: 1 },
  balanced: { minCutoff: 1.2, beta: 0.08, derivativeCutoff: 1 },
  smooth: { minCutoff: 0.65, beta: 0.04, derivativeCutoff: 1 },
};

// A gap starts a fresh filter. Missing observations are never synthesized.
export const MAX_FILTER_GAP_MS = 250;

function alpha(cutoff: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSeconds);
}

export class OneEuroFilter {
  private previousTimestamp: number | undefined;
  private previousRaw = 0;
  private previousFiltered = 0;
  private previousDerivative = 0;
  private readonly options: FilterOptions;

  constructor(options: FilterOptions = PRESETS.balanced) {
    this.options = options;
  }

  filter(value: number, timestampMs: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(timestampMs)) {
      throw new Error('A filter sample must have a finite value and timestamp.');
    }

    const elapsedMs = this.previousTimestamp === undefined
      ? Infinity
      : timestampMs - this.previousTimestamp;

    if (elapsedMs <= 0 || elapsedMs > MAX_FILTER_GAP_MS) {
      this.previousTimestamp = timestampMs;
      this.previousRaw = value;
      this.previousFiltered = value;
      this.previousDerivative = 0;
      return value;
    }

    const dt = elapsedMs / 1000;
    const derivative = (value - this.previousRaw) / dt;
    const derivativeAlpha = alpha(this.options.derivativeCutoff, dt);
    const filteredDerivative = derivativeAlpha * derivative
      + (1 - derivativeAlpha) * this.previousDerivative;
    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(filteredDerivative);
    const valueAlpha = alpha(cutoff, dt);
    const filtered = valueAlpha * value + (1 - valueAlpha) * this.previousFiltered;

    this.previousTimestamp = timestampMs;
    this.previousRaw = value;
    this.previousFiltered = filtered;
    this.previousDerivative = filteredDerivative;
    return filtered;
  }
}

export function cloneLandmarkSet(input: LandmarkSet): LandmarkSet {
  return {
    pose: input.pose.map(point => ({ ...point })),
    poseWorld: input.poseWorld.map(point => ({ ...point })),
    face: input.face.map(point => ({ ...point })),
    leftHand: input.leftHand.map(point => ({ ...point })),
    rightHand: input.rightHand.map(point => ({ ...point })),
    blendshapes: { ...input.blendshapes },
  };
}

export class LandmarkSmoother {
  private readonly filters = new Map<string, OneEuroFilter>();
  private readonly preset: SmoothingPreset;

  constructor(preset: SmoothingPreset) {
    this.preset = preset;
  }

  reset(): void {
    this.filters.clear();
  }

  private sample(key: string, value: number, timestampMs: number): number {
    if (this.preset === 'raw') return value;
    let filter = this.filters.get(key);
    if (!filter) {
      filter = new OneEuroFilter(PRESETS[this.preset]);
      this.filters.set(key, filter);
    }
    return filter.filter(value, timestampMs);
  }

  private landmarks(name: string, points: Landmark[], timestampMs: number): Landmark[] {
    return points.map((point, index) => {
      const prefix = `${name}.${index}`;
      // Keep the measured confidence, including low-confidence observations.
      // Reset their filters so reacquisition cannot blend against a bad point.
      if (Math.min(point.visibility ?? 1, point.presence ?? 1) < 0.2) {
        this.filters.delete(`${prefix}.x`);
        this.filters.delete(`${prefix}.y`);
        this.filters.delete(`${prefix}.z`);
        return { ...point };
      }
      return {
        ...point,
        x: this.sample(`${prefix}.x`, point.x, timestampMs),
        y: this.sample(`${prefix}.y`, point.y, timestampMs),
        z: this.sample(`${prefix}.z`, point.z, timestampMs),
      };
    });
  }

  process(input: LandmarkSet, timestampMs: number): LandmarkSet {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      throw new Error('Motion timestamps must be finite and non-negative.');
    }
    if (this.preset === 'raw') return cloneLandmarkSet(input);

    const blendshapes: Record<string, number> = {};
    for (const [name, value] of Object.entries(input.blendshapes)) {
      blendshapes[name] = this.sample(`blendshape.${name}`, value, timestampMs);
    }
    return {
      pose: this.landmarks('pose', input.pose, timestampMs),
      poseWorld: this.landmarks('poseWorld', input.poseWorld, timestampMs),
      face: this.landmarks('face', input.face, timestampMs),
      leftHand: this.landmarks('leftHand', input.leftHand, timestampMs),
      rightHand: this.landmarks('rightHand', input.rightHand, timestampMs),
      blendshapes,
    };
  }
}

const BODY_CONFIDENCE_INDICES = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export function bodyConfidence(pose: Landmark[]): number {
  if (!pose.length) return 0;
  const total = BODY_CONFIDENCE_INDICES.reduce((sum, index) => {
    const point = pose[index];
    if (!point) return sum;
    const score = Math.min(point.visibility ?? point.presence ?? 0, point.presence ?? 1);
    return sum + (Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0);
  }, 0);
  return total / BODY_CONFIDENCE_INDICES.length;
}
