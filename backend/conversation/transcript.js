// Gemini Live transcribes speech in fragments ("C'est", " quo", "i la"…): join them into one
// utterance (as received — fragments carry their own spaces) and hand it over once.
export class TranscriptBuffer {
  constructor() {
    this.raw = '';
  }

  /** Add a fragment; returns the utterance so far. */
  add(fragment) {
    this.raw += String(fragment || '');
    return this.text;
  }

  get text() {
    return this.raw.replace(/\s+/g, ' ').trim();
  }

  /** The finished utterance (null if nothing was said); starts a new one. */
  flush() {
    const t = this.text;
    this.raw = '';
    return t || null;
  }
}
