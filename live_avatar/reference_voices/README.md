# 🎙️ AVTR-1 Reference Voices Catalog

This folder contains the reference voice audio files (`.ogg`, `.wav`, or `.mp3`) for the AVTR-1 live avatars.

## 📁 File Naming Convention

Place your reference audio file here named as `<avatar_id>.ogg` or `<avatar_id>.wav` (e.g. `maria.ogg`, `elena.ogg`, `marcus.ogg`, `kate.ogg`, `john.ogg`, `ben.ogg`).

## ⚡ How It Works

When a Live Avatar session starts:
1. **Acoustic Profiling**: The `VoiceConverter` automatically reads the avatar's corresponding `.ogg` file and extracts its acoustic signature (pitch contour, spectral centroid, resonance, and formant spectrum).
2. **Zero-Latency Timbre Transformation**: In Gemini Live and Agent modes, incoming audio chunks are morphed in real-time (<5ms latency) to match the target character's timbre, formant resonance, and pitch.
3. **AVTR-1 Lip-Sync**: The transformed audio is fed simultaneously to the WebRTC audio output and AVTR-1's HuBERT feature extractor for synchronized 25 FPS facial animations.

## 🎭 Default Avatar Mappings

| Avatar ID | Default Reference File | Vocal Character |
| :--- | :--- | :--- |
| `elena` | `elena.ogg` (or `speaker_1.ogg`) | Elegant, articulate European female timbre |
| `marcus` | `marcus.ogg` (or `speaker_2.ogg`) | Deep, smooth, dynamic baritone |
| `maria` | `maria.ogg` | Warm, melodic mid-high timbre |
| `kate` | `kate.ogg` | Bright, energetic high-clarity timbre |
| `clara` | `clara.ogg` | Smooth, natural conversational timbre |
| `ben` | `ben.ogg` | Youthful, energetic mid-range male |
| `john` | `john.ogg` | Deep, broadcast baritone |
| `arnold` | `arnold.ogg` | Heavy, deep cinematic bass |
| `may` | `may.ogg` | Soft, delicate timbre |
| `camila` | `camila.ogg` | Vibrant, warm timbre |
