// The live avatar (on a GPU server) posts what the user says to POST /api/avatar/transcript.
// Older streamers post every transcription fragment ("C'est", "quo", "i la"…) as a final line;
// collect them into one utterance, logged once: when Jarvis answers or delegates (flush) or
// after a short pause. Current streamers post whole utterances, which pass through the same way.
export class UtteranceJoiner {
  constructor({ onUtterance, idleMs = 1200, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.onUtterance = onUtterance;
    this.idleMs = idleMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.parts = [];
    this.timer = null;
  }

  get text() {
    return this.parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /** Add a fragment; returns the utterance so far (for the live caption). */
  add(fragment) {
    const piece = String(fragment || '').trim();
    if (piece) this.parts.push(piece);
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.flush(), this.idleMs);
    this.timer?.unref?.();
    return this.text;
  }

  /** The utterance is over: hand it over once. */
  flush() {
    this.clearTimer(this.timer);
    this.timer = null;
    const text = this.text;
    this.parts = [];
    if (text) this.onUtterance(text);
  }
}
