// Mono audio from the microphone's rate (48 kHz, 44.1 kHz…) to 16 kHz for the standby
// listener (clap detector, speech segments for the on-device wake-word model). A box filter
// over one output period (anti-aliasing good enough for speech and claps) + linear
// interpolation; streaming, any chunk size, no allocation per chunk. At 16 kHz it's a copy.

export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  private readonly step: number; // input samples per output sample
  private readonly taps: number; // box filter length (input samples)
  private readonly ring: Float32Array; // last `taps` input samples
  private ringPos = 0;
  private ringSum = 0;
  private prevFiltered = 0;
  private filteredCount = 0; // input samples seen (filtered)
  private nextOut = 0; // position (in input samples) of the next output sample
  private out: Float32Array;

  constructor(inRate: number, outRate = 16000) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.taps = Math.max(1, Math.round(this.step));
    this.ring = new Float32Array(this.taps);
    this.out = new Float32Array(256);
  }

  /** Feeds input samples; returns the resampled ones (valid until the next call). */
  push(input: ArrayLike<number>): Float32Array {
    if (this.step === 1) {
      if (this.out.length < input.length) this.out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) this.out[i] = input[i];
      return this.out.subarray(0, input.length);
    }
    const max = Math.ceil(input.length / this.step) + 2;
    if (this.out.length < max) this.out = new Float32Array(max);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      // Moving average over the last `taps` samples.
      this.ringSum += input[i] - this.ring[this.ringPos];
      this.ring[this.ringPos] = input[i];
      this.ringPos = (this.ringPos + 1) % this.taps;
      const filtered = this.ringSum / this.taps;
      const pos = this.filteredCount; // index of `filtered`
      // Output samples that fall between the previous filtered sample and this one.
      while (this.nextOut <= pos) {
        const frac = this.nextOut - (pos - 1);
        this.out[n++] = pos === 0 ? filtered : this.prevFiltered + (filtered - this.prevFiltered) * Math.max(0, frac);
        this.nextOut += this.step;
      }
      this.prevFiltered = filtered;
      this.filteredCount++;
    }
    // Keep the counters small (float precision over hours of audio).
    if (this.filteredCount > 1e6) {
      const shift = this.filteredCount - 1;
      this.filteredCount -= shift;
      this.nextOut -= shift;
    }
    return this.out.subarray(0, n);
  }

  reset() {
    this.ring.fill(0);
    this.ringPos = 0;
    this.ringSum = 0;
    this.prevFiltered = 0;
    this.filteredCount = 0;
    this.nextOut = 0;
  }
}
