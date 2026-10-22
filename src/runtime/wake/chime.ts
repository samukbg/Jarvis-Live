// A short, soft two-note chime: "I heard you" before Jarvis starts listening.
let ctx: AudioContext | null = null;

export function playChime(volume = 0.12) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(ctx.destination);
    // A rising fifth (E5 → B5), sine with a gentle attack and a quick fade.
    [[659.25, 0], [987.77, 0.085]].forEach(([freq, at]) => {
      const osc = ctx!.createOscillator();
      const env = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, t0 + at);
      env.gain.linearRampToValueAtTime(1, t0 + at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.22);
      osc.connect(env).connect(out);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.24);
    });
    setTimeout(() => out.disconnect(), 600);
  } catch {
    // No audio output: listening starts anyway.
  }
}
