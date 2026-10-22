// Speech segments for the "Hey Jarvis" standby listener: a simple energy VAD on 16 kHz mono,
// 10 ms frames. Only these short segments ever reach the on-device speech model (Moonshine),
// so it sleeps while the room is quiet.
//
//   - speech starts after 3 loud frames out of 5 (well above the room's noise floor)
//   - each segment carries ~300 ms of audio from before the start (the "H" of "Hey")
//   - it ends after ~400 ms of quiet; segments with < 250 ms of speech are dropped (clicks, a cough)
//   - at 2.5 s of audio a `probe` (the first 2.5 s) goes out while recording continues: the wake
//     phrase is always at the start, so that's enough to decide; the `final` (whole utterance,
//     up to 10 s) follows when it ends — for "Hey Jarvis, what's the weather in Paris" the
//     probe says "Hey Jarvis", the final has the whole question.

export const SEGMENT = {
  sampleRate: 16000,
  frameMs: 10,
  /** A frame is speech when this far above the noise floor… */
  speechAboveFloorDb: 12,
  /** …and at least this loud (dBFS). */
  minLevelDb: -55,
  /** Speech starts when `startFrames` of the last `startWindow` frames are speech. */
  startFrames: 3,
  startWindow: 5,
  preRollMs: 300,
  /** The segment ends after this much quiet. */
  endSilenceMs: 400,
  /** Kept after the last speech frame (the tail of the last word). */
  tailMs: 150,
  /** Less speech than this: dropped. */
  minSpeechMs: 250,
  /** The probe: this much audio (pre-roll included). */
  probeMs: 2500,
  /** A segment never grows beyond this; then it ends and the rest of that speech is ignored. */
  maxMs: 10000,
  floorInitDb: -70,
  floorRiseDbPerFrame: 0.05,
} as const;

export interface Segment {
  /** Same id for a segment's probe and its final. */
  id: number;
  kind: 'probe' | 'final';
  /** 16 kHz mono. */
  audio: Float32Array;
  /** The final of a segment that already had a probe. */
  probed: boolean;
  /** Audio time (ms since the segmenter started) when the segment's speech started / its audio ends. */
  startMs: number;
  endMs: number;
}

const dB = (power: number) => 10 * Math.log10(power + 1e-12);

type OpenSegment = { id: number; frames: Float32Array[]; startFrame: number; firstFrame: number; lastSpeech: number; speechFrames: number; probed: boolean };

export class SpeechSegmenter {
  private readonly frameLen = (SEGMENT.sampleRate * SEGMENT.frameMs) / 1000;
  private readonly frameBuf = new Float32Array(this.frameLen);
  private fill = 0;
  private frame = 0;
  private floor: number = SEGMENT.floorInitDb;
  private readonly recent: boolean[] = []; // speech flags of the last startWindow frames
  /** Pre-roll: the frames before a segment (preRollMs before its first speech frame, + the start window). */
  private readonly preRoll: Float32Array[] = [];
  private readonly preRollFrames = SEGMENT.preRollMs / SEGMENT.frameMs + SEGMENT.startWindow;
  private seg: OpenSegment | null = null;
  /** After a segment hit maxMs: ignore until quiet. */
  private skipping = false;
  private quietRun = 0;
  private nextId = 1;
  private readonly onSegment: (s: Segment) => void;

  constructor(onSegment: (s: Segment) => void) {
    this.onSegment = onSegment;
  }

  push(samples: ArrayLike<number>) {
    for (let i = 0; i < samples.length; i++) {
      this.frameBuf[this.fill++] = samples[i];
      if (this.fill === this.frameLen) {
        this.processFrame(this.frameBuf.slice());
        this.fill = 0;
      }
    }
  }

  /** Is a segment being recorded now (someone is talking)? */
  get active() {
    return this.seg !== null;
  }

  private processFrame(frame: Float32Array) {
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    const level = dB(energy / frame.length);
    const speech = level >= SEGMENT.minLevelDb && level - this.floor >= SEGMENT.speechAboveFloorDb;
    const f = this.frame++;

    // The noise floor: falls at once, rises slowly (not while someone is talking).
    if (level < this.floor) this.floor = level;
    else if (!speech) this.floor = Math.min(level, this.floor + SEGMENT.floorRiseDbPerFrame);
    else this.floor = Math.min(level, this.floor + SEGMENT.floorRiseDbPerFrame / 4);

    this.recent.push(speech);
    if (this.recent.length > SEGMENT.startWindow) this.recent.shift();

    if (this.skipping) {
      this.quietRun = speech ? 0 : this.quietRun + 1;
      if (this.quietRun * SEGMENT.frameMs >= SEGMENT.endSilenceMs) {
        this.skipping = false;
        this.recent.length = 0;
      }
      this.keepPreRoll(frame);
      return;
    }

    const seg = this.seg;
    if (!seg) {
      this.keepPreRoll(frame);
      if (this.recent.filter(Boolean).length >= SEGMENT.startFrames) {
        // The first speech frame of the window is where the speech started.
        const firstSpeech = f - (this.recent.length - 1 - this.recent.indexOf(true));
        const frames = this.preRoll.splice(0).slice(-(f - firstSpeech + 1 + SEGMENT.preRollMs / SEGMENT.frameMs));
        this.seg = {
          id: this.nextId++,
          frames,
          startFrame: firstSpeech,
          firstFrame: f - frames.length + 1,
          lastSpeech: f,
          speechFrames: this.recent.filter(Boolean).length,
          probed: false,
        };
      }
      return;
    }

    seg.frames.push(frame);
    if (speech) {
      seg.lastSpeech = f;
      seg.speechFrames++;
    }
    const lengthMs = seg.frames.length * SEGMENT.frameMs;
    if (!seg.probed && lengthMs >= SEGMENT.probeMs) {
      seg.probed = true;
      this.emit(seg, 'probe', seg.frames.length);
    }
    if ((f - seg.lastSpeech) * SEGMENT.frameMs >= SEGMENT.endSilenceMs) {
      this.finish(seg);
    } else if (lengthMs >= SEGMENT.maxMs) {
      this.finish(seg);
      this.skipping = true;
      this.quietRun = 0;
    }
  }

  private keepPreRoll(frame: Float32Array) {
    this.preRoll.push(frame);
    if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
  }

  private finish(seg: OpenSegment) {
    this.seg = null;
    this.recent.length = 0;
    if (seg.speechFrames * SEGMENT.frameMs < SEGMENT.minSpeechMs) return;
    // Up to the last speech frame + the tail.
    const keep = Math.min(seg.frames.length, seg.lastSpeech - seg.firstFrame + 1 + SEGMENT.tailMs / SEGMENT.frameMs);
    this.emit(seg, 'final', keep);
  }

  private emit(seg: OpenSegment, kind: Segment['kind'], frames: number) {
    const audio = new Float32Array(frames * this.frameLen);
    for (let i = 0; i < frames; i++) audio.set(seg.frames[i], i * this.frameLen);
    this.onSegment({
      id: seg.id,
      kind,
      audio,
      probed: kind === 'final' && seg.probed,
      startMs: seg.startFrame * SEGMENT.frameMs,
      endMs: (seg.firstFrame + frames) * SEGMENT.frameMs,
    });
  }

  /** Forget everything (after the mic restarts). */
  reset() {
    this.fill = 0;
    this.seg = null;
    this.skipping = false;
    this.quietRun = 0;
    this.recent.length = 0;
    this.preRoll.length = 0;
    this.floor = SEGMENT.floorInitDb;
  }
}
