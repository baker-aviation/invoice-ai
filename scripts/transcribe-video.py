#!/usr/bin/env python3
"""
Transcribe a video file and extract screenshots every N seconds.

Requirements:
  brew install ffmpeg        # if not already installed
  pip install openai         # for Whisper API

Usage:
  python3 scripts/transcribe-video.py "path/to/video.mov"
  python3 scripts/transcribe-video.py "path/to/video.mov" --interval 5  # every 5 sec
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def check_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except FileNotFoundError:
        print("ERROR: ffmpeg not found. Install it with: brew install ffmpeg")
        sys.exit(1)


def extract_screenshots(video_path: str, output_dir: str, interval: int = 3):
    """Extract a frame every `interval` seconds."""
    screenshots_dir = os.path.join(output_dir, "screenshots")
    os.makedirs(screenshots_dir, exist_ok=True)

    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"fps=1/{interval}",
        "-q:v", "2",  # high quality JPEG
        os.path.join(screenshots_dir, "frame_%04d.jpg"),
        "-y",  # overwrite
    ]
    print(f"Extracting screenshots every {interval}s...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ffmpeg error: {result.stderr}")
        sys.exit(1)

    frames = sorted(Path(screenshots_dir).glob("frame_*.jpg"))
    print(f"Extracted {len(frames)} screenshots to {screenshots_dir}/")
    return frames


def extract_audio(video_path: str, output_dir: str) -> str:
    """Extract audio as MP3 for Whisper API."""
    audio_path = os.path.join(output_dir, "audio.mp3")
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vn",           # no video
        "-acodec", "libmp3lame",
        "-ab", "128k",
        "-ar", "16000",  # 16kHz mono is ideal for Whisper
        "-ac", "1",
        audio_path,
        "-y",
    ]
    print("Extracting audio...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ffmpeg error: {result.stderr}")
        sys.exit(1)

    size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    print(f"Audio extracted: {audio_path} ({size_mb:.1f} MB)")

    if size_mb > 25:
        print("WARNING: Audio is >25MB. Whisper API limit is 25MB per request.")
        print("The script will split it into chunks automatically.")
    return audio_path


def split_audio(audio_path: str, chunk_minutes: int = 10) -> list[str]:
    """Split audio into chunks if it exceeds 25MB."""
    size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    if size_mb <= 24:
        return [audio_path]

    output_dir = os.path.dirname(audio_path)
    chunks = []
    chunk_idx = 0

    # Get duration
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", audio_path],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    chunk_secs = chunk_minutes * 60

    start = 0
    while start < duration:
        chunk_path = os.path.join(output_dir, f"audio_chunk_{chunk_idx:03d}.mp3")
        cmd = [
            "ffmpeg", "-i", audio_path,
            "-ss", str(start),
            "-t", str(chunk_secs),
            "-acodec", "libmp3lame", "-ab", "128k",
            chunk_path, "-y"
        ]
        subprocess.run(cmd, capture_output=True, check=True)
        chunks.append(chunk_path)
        chunk_idx += 1
        start += chunk_secs

    print(f"Split audio into {len(chunks)} chunks")
    return chunks


def transcribe_audio(audio_path: str) -> str:
    """Transcribe audio using OpenAI Whisper API."""
    try:
        from openai import OpenAI
    except ImportError:
        print("ERROR: openai package not found. Install with: pip install openai")
        sys.exit(1)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("ERROR: OPENAI_API_KEY environment variable not set.")
        print("  export OPENAI_API_KEY='sk-...'")
        sys.exit(1)

    client = OpenAI(api_key=api_key)
    chunks = split_audio(audio_path)
    full_transcript = []

    for i, chunk in enumerate(chunks):
        if len(chunks) > 1:
            print(f"Transcribing chunk {i + 1}/{len(chunks)}...")
        else:
            print("Transcribing audio with Whisper...")

        with open(chunk, "rb") as f:
            response = client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="verbose_json",
            )

        full_transcript.append(response.text)

    return "\n\n".join(full_transcript)


def main():
    parser = argparse.ArgumentParser(description="Transcribe video + extract screenshots")
    parser.add_argument("video", help="Path to the video file")
    parser.add_argument("--interval", type=int, default=3, help="Screenshot interval in seconds (default: 3)")
    parser.add_argument("--output", help="Output directory (default: next to video)")
    args = parser.parse_args()

    video_path = os.path.abspath(args.video)
    if not os.path.exists(video_path):
        print(f"ERROR: Video not found: {video_path}")
        sys.exit(1)

    check_ffmpeg()

    # Output dir next to the video
    if args.output:
        output_dir = os.path.abspath(args.output)
    else:
        video_name = Path(video_path).stem
        output_dir = os.path.join(os.path.dirname(video_path), f"{video_name}_output")

    os.makedirs(output_dir, exist_ok=True)
    print(f"Output directory: {output_dir}\n")

    # Extract screenshots
    frames = extract_screenshots(video_path, output_dir, args.interval)

    # Extract & transcribe audio
    audio_path = extract_audio(video_path, output_dir)
    transcript = transcribe_audio(audio_path)

    # Save transcript
    transcript_path = os.path.join(output_dir, "transcript.txt")
    with open(transcript_path, "w") as f:
        f.write(transcript)

    print(f"\n{'=' * 60}")
    print(f"DONE!")
    print(f"  Screenshots: {output_dir}/screenshots/ ({len(frames)} frames)")
    print(f"  Transcript:  {transcript_path}")
    print(f"{'=' * 60}")
    print(f"\nTranscript preview:\n")
    print(transcript[:500] + ("..." if len(transcript) > 500 else ""))


if __name__ == "__main__":
    main()
