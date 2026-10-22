// Double-clap detection: the reference implementation. The web/desktop audio worklet runs this
// file; the iPhone, Android and Apple Watch standby engines port it line for line (keep the
// constants and the steps identical — clapDetector.test.ts holds the cases they must agree on).
//
// Input: mono PCM in [-1, 1] at any rate, fed in any chunk size. It works on 10 ms frames:
//   1. the frame's level (dB) and how much of it is high-frequency (first-difference energy /
//      energy — a clap is a broadband crack, speech and hums are mostly low)
//   2. a slow noise floor (the quiet level of the room)
//   3. a clap = a sudden onset (well above the floor, a jump from the frame before) that was
//      preceded by quiet (not in the middle of speech) and dies away fast (impulsive)
//   4. two claps 150–700 ms apart, then quiet: a third one cancels (applause, knocking, music)

export const CLAP = {
  frameMs: 10,
  /** The onset must be this far above the noise floor… */
  minAboveFloorDb: 18,
  /** …and jump this much from the frame before. */
  minRiseDb: 10,
  /** …and be at least this loud (dBFS), so distant taps don't count. */
  minLevelDb: -38,
  /**
   * Share of high-frequency energy at the onset. Off: real claps through laptop and phone mics
   * measured 0.01–0.95 (median ≈ 0.1) at 16 kHz, so it rejected most of them; the shape
   * (sudden rise from quiet, fast fade) is what tells a clap from speech.
   */
  minHighRatio: 0,
  /** The 150 ms before the onset stays this far below it (not mid-word). */
  quietBeforeMs: 150,
  quietBeforeDb: 12,
  /** Within this time after the onset the level falls this much (impulsive, not a sustained sound). */
  decayWithinMs: 90,
  decayDb: 10, // real claps faded 11–37 dB in 90 ms (a vowel: ~0)
  /** The second clap comes this long after the first. */
  minGapMs: 150,
  maxGapMs: 700,
  /** No third clap during this time after the second. */
  guardMs: 350,
  /** Nothing fires again for this long after a double clap. */
  cooldownMs: 1500,
  /** Noise floor: rises slowly, falls fast (tracks the quiet level). */
  floorRiseDbPerFrame: 0.05,
  floorInitDb: -60,
} as const;

const dB = (power: number) => 10 * Math.log10(power + 1e-12);

export interface ClapDetectorOptions {
  sampleRate: number;
  /** Called once per double clap, with the time (ms of audio fed so far) of the second clap. */
  onDoubleClap: (atMs: number) => void;
  /** 0.5 (fewer false triggers) … 1.5 (more sensitive); scales the loudness thresholds. */
  sensitivity?: number;
}

type Candidate = { frame: number; levelDb: number; checkUntil: number };

export class ClapDetector {
  private readonly frameLen: number;
  private readonly buf: Float32Array;
  private fill = 0;
  private prevSample = 0;
  private frame = 0;
  private floor: number = CLAP.floorInitDb;
  private lastLevel: number = CLAP.floorInitDb;
  private readonly history: number[] = []; // recent frame levels (dB), newest last
  private candidate: Candidate | null = null;
  private claps: number[] = []; // frames of confirmed claps not yet resolved
  private cooldownUntil = -1;
  private readonly scale: number;
  private readonly opts: ClapDetectorOptions;

  constructor(opts: ClapDetectorOptions) {
    this.opts = opts;
    this.frameLen = Math.max(1, Math.round((opts.sampleRate * CLAP.frameMs) / 1000));
    this.buf = new Float32Array(this.frameLen);
    this.scale = Math.min(1.5, Math.max(0.5, opts.sensitivity ?? 1));
  }

  private ms(frames: number) {
    return frames * CLAP.frameMs;
  }

  /** Feeds samples (any length). */
  push(samples: ArrayLike<number>) {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.fill++] = samples[i];
      if (this.fill === this.frameLen) {
        this.processFrame();
        this.fill = 0;
      }
    }
  }

  private processFrame() {
    let energy = 0;
    let diff = 0;
    let prev = this.prevSample;
    for (let i = 0; i < this.frameLen; i++) {
      const s = this.buf[i];
      energy += s * s;
      const d = s - prev;
      diff += d * d;
      prev = s;
    }
    this.prevSample = prev;
    const level = dB(energy / this.frameLen);
    const highRatio = energy > 1e-9 ? diff / energy / 2 : 0; // white noise ≈ 1, a 200 Hz tone ≈ 0.008
    const f = this.frame;

    // 1. A candidate onset waits for its decay check.
    if (this.candidate && f <= this.candidate.checkUntil) {
      if (this.candidate.levelDb - level >= CLAP.decayDb) {
        this.confirm(this.candidate.frame);
        this.candidate = null;
      } else if (f === this.candidate.checkUntil) {
        this.candidate = null; // sustained: a word, a bang that rings, music
      }
    }

    // 2. A new onset?
    // More sensitive: a lower jump above the room's noise counts (18 dB → 13 dB at 1.3).
    const above = (CLAP.minAboveFloorDb / this.scale) | 0;
    const minLevel = CLAP.minLevelDb + (1 - this.scale) * 12;
    const quietFrames = Math.round(CLAP.quietBeforeMs / CLAP.frameMs);
    const before = this.history.slice(-quietFrames);
    const quietBefore = before.length >= quietFrames / 2 && Math.max(...before) <= level - CLAP.quietBeforeDb;
    if (
      !this.candidate &&
      f >= this.cooldownUntil &&
      level >= minLevel &&
      level - this.floor >= above &&
      level - this.lastLevel >= CLAP.minRiseDb &&
      highRatio >= CLAP.minHighRatio &&
      quietBefore
    ) {
      this.candidate = { frame: f, levelDb: level, checkUntil: f + Math.round(CLAP.decayWithinMs / CLAP.frameMs) };
    }

    // 3. Resolve pairs: fire after the guard time when exactly two claps were heard.
    if (this.claps.length) {
      const first = this.claps[0];
      const last = this.claps[this.claps.length - 1];
      if (this.claps.length >= 3) {
        // Applause, knocking, a beat: wait for quiet, then start over.
        if (this.ms(f - last) > CLAP.maxGapMs) this.claps = [];
      } else if (this.claps.length === 2 && this.ms(f - last) >= CLAP.guardMs) {
        this.claps = [];
        this.cooldownUntil = f + Math.round(CLAP.cooldownMs / CLAP.frameMs);
        this.opts.onDoubleClap(this.ms(last));
      } else if (this.claps.length === 1 && this.ms(f - first) > CLAP.maxGapMs) {
        this.claps = []; // a single clap
      }
    }

    // 4. The noise floor (from frames that aren't onsets) and the history.
    if (level < this.floor) this.floor = level;
    else if (!this.candidate) this.floor = Math.min(level, this.floor + CLAP.floorRiseDbPerFrame);
    this.lastLevel = level;
    this.history.push(level);
    if (this.history.length > 64) this.history.shift();
    this.frame++;
  }

  private confirm(frame: number) {
    const last = this.claps[this.claps.length - 1];
    if (last !== undefined && this.ms(frame - last) < CLAP.minGapMs) return; // the same clap's echo
    if (this.claps.length === 1 && this.ms(frame - last) > CLAP.maxGapMs) this.claps = [];
    this.claps.push(frame);
  }

  /** Forget everything (after the mic restarts). */
  reset() {
    this.fill = 0;
    this.candidate = null;
    this.claps = [];
    this.history.length = 0;
    this.floor = CLAP.floorInitDb;
    this.lastLevel = CLAP.floorInitDb;
  }
}
