#!/usr/bin/env python3
"""Generate distinct, high-fidelity .ogg reference voices for all 17 AVTR-1 avatars."""

import os
import subprocess
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "reference_voices"
EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "example"
OUT_DIR.mkdir(parents=True, exist_ok=True)

AVATAR_SCRIPTS = [
    {
        "id": "maria",
        "voice": "Samantha",
        "text": "Hello! I am Maria, your personal AI avatar. I am here to assist you with a warm, natural, and clear voice.",
        "pitch_rate": 24960,
        "eq": "equalizer=f=3500:t=q:w=1.5:g=2",
    },
    {
        "id": "kate",
        "voice": "Karen",
        "text": "Hey there! I am Kate. Let's make things happen quickly and efficiently with bright energy!",
        "pitch_rate": 26880,
        "eq": "equalizer=f=4000:t=q:w=1.2:g=3",
    },
    {
        "id": "clara",
        "voice": "Moira",
        "text": "Greetings. My name is Clara. I offer calm, thoughtful, and articulate guidance for your daily workflow.",
        "pitch_rate": 24480,
        "eq": "equalizer=f=3000:t=q:w=1.0:g=1",
    },
    {
        "id": "elena",
        "source_file": EXAMPLE_DIR / "speaker_1.ogg",
        "text": "Elena reference track",
    },
    {
        "id": "may",
        "voice": "Tessa",
        "text": "Hi! I am May. I am always happy to help you with gentle support and careful attention.",
        "pitch_rate": 27600,
        "eq": "equalizer=f=4500:t=q:w=1.5:g=2.5",
    },
    {
        "id": "camila",
        "voice": "Paulina",
        "text": "Hola, I am Camila! Ready to bring dynamic energy, creativity, and vibrant conversations to life.",
        "pitch_rate": 25920,
        "eq": "equalizer=f=3200:t=q:w=1.2:g=2",
    },
    {
        "id": "caroline",
        "voice": "Serena",
        "text": "Good day. I am Caroline. I provide structured, precise, and executive-level intelligence.",
        "pitch_rate": 24720,
        "eq": "equalizer=f=2800:t=q:w=1.0:g=1.5",
    },
    {
        "id": "ben",
        "voice": "Alex",
        "text": "Hey what's up! I'm Ben. Let's build something awesome together with speed and focus.",
        "pitch_rate": 25440,
        "eq": "equalizer=f=2200:t=q:w=1.0:g=2",
    },
    {
        "id": "john",
        "voice": "Daniel",
        "text": "Hello, I am John. Standing by to execute your directives with steadfast reliability and depth.",
        "pitch_rate": 22080,
        "eq": "equalizer=f=250:t=q:w=1.0:g=3",
    },
    {
        "id": "oliver",
        "voice": "Oliver",
        "text": "Good day to you! I am Oliver, ready to assist with refined intellect and articulate dialogue.",
        "pitch_rate": 24480,
        "eq": "equalizer=f=3000:t=q:w=1.2:g=1.5",
    },
    {
        "id": "ming",
        "voice": "Alex",
        "text": "Hello. I am Ming. Focused, calm, and analytical precision for all your complex queries.",
        "pitch_rate": 24000,
        "eq": "equalizer=f=1800:t=q:w=1.0:g=1",
    },
    {
        "id": "jack",
        "voice": "Tom",
        "text": "Hey there, I am Jack. Let's cut straight to the point and get the job done right.",
        "pitch_rate": 22800,
        "eq": "equalizer=f=400:t=q:w=1.0:g=2",
    },
    {
        "id": "arnold",
        "voice": "Ralph",
        "text": "I am Arnold. Maximum power, deep computational strength, and unmatched resilience.",
        "pitch_rate": 20160,
        "eq": "equalizer=f=180:t=q:w=1.0:g=4",
    },
    {
        "id": "gordon",
        "voice": "Daniel",
        "text": "Greetings. Gordon here. Let us examine the data carefully and formulate an optimal solution.",
        "pitch_rate": 21360,
        "eq": "equalizer=f=220:t=q:w=1.0:g=2.5",
    },
    {
        "id": "marcus",
        "source_file": EXAMPLE_DIR / "speaker_2.ogg",
        "text": "Marcus reference track",
    },
    {
        "id": "mozart",
        "voice": "Alex",
        "text": "Salutations! I am Mozart. Let us compose harmonious thoughts, brilliance, and innovative ideas.",
        "pitch_rate": 26880,
        "eq": "equalizer=f=3500:t=q:w=1.5:g=3",
    },
    {
        "id": "trevor",
        "voice": "Tom",
        "text": "Hey. Trevor here. Keeping it real, no nonsense, and ready for whatever challenge comes next.",
        "pitch_rate": 20880,
        "eq": "equalizer=f=300:t=q:w=1.0:g=3",
    },
]

def main():
    print(f"Generating reference voices in {OUT_DIR}...")
    for item in AVATAR_SCRIPTS:
        avatar_id = item["id"]
        out_path = OUT_DIR / f"{avatar_id}.ogg"

        if "source_file" in item and item["source_file"].exists():
            print(f"Copying existing reference for {avatar_id} -> {out_path.name}")
            subprocess.run(["cp", str(item["source_file"]), str(out_path)], check=True)
            continue

        temp_aiff = OUT_DIR / f"temp_{avatar_id}.aiff"
        voice = item.get("voice", "Samantha")
        text = item["text"]

        # 1. Synthesize with macOS say
        cmd_say = ["say", "-v", voice, "-o", str(temp_aiff), text]
        res = subprocess.run(cmd_say, capture_output=True)
        if res.returncode != 0:
            # Fallback to default voice
            subprocess.run(["say", "-o", str(temp_aiff), text], check=True)

        # 2. Filter & Encode to 24kHz Opus/Ogg
        pitch_rate = item.get("pitch_rate", 24000)
        eq = item.get("eq", "aresample=24000")
        af = f"asetrate=r={pitch_rate},aresample=24000,{eq}"

        cmd_ffmpeg = [
            "ffmpeg", "-y", "-i", str(temp_aiff),
            "-af", af,
            "-ar", "24000",
            "-ac", "1",
            "-c:a", "libopus",
            "-b:a", "48k",
            str(out_path)
        ]
        subprocess.run(cmd_ffmpeg, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

        if temp_aiff.exists():
            temp_aiff.unlink()

        print(f"Generated {avatar_id}.ogg ({os.path.getsize(out_path)} bytes)")

    print("All 17 avatar reference voice .ogg files created successfully!")

if __name__ == "__main__":
    main()
