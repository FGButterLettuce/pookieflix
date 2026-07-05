#!/usr/bin/env python3
"""Transcode any video to Mac-compatible H.264/AAC MP4, auto-detecting audio layout."""
import json, subprocess, sys
from pathlib import Path


def probe(src):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", src],
        capture_output=True, text=True, check=True,
    )
    return json.loads(r.stdout)["streams"]


def has_encoder(name):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True)
    return name in r.stdout


def build_cmd(src):
    streams = probe(src)
    video = next((s for s in streams if s["codec_type"] == "video"), None)
    audio = next((s for s in streams if s["codec_type"] == "audio"), None)
    out = str(Path(src).with_suffix(".mp4"))

    use_vt = has_encoder("h264_videotoolbox")
    already_h264 = video and video.get("codec_name") == "h264"

    cmd = ["ffmpeg"]
    if use_vt:
        cmd += ["-hwaccel", "videotoolbox"]
    cmd += ["-i", src]

    # Video
    if use_vt:
        cmd += ["-c:v", "h264_videotoolbox", "-b:v", "6000k", "-tag:v", "avc1"]
    elif already_h264:
        cmd += ["-c:v", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "slow", "-tag:v", "avc1"]

    # Audio — downmix surround to stereo with DPLII matrix (sounds way better than default mix)
    channels = int(audio["channels"]) if audio else 2
    cmd += ["-c:a", "aac", "-b:a", "192k"]
    if channels > 2:
        cmd += ["-ac", "2", "-af", "aresample=matrix_encoding=dplii"]

    cmd += ["-movflags", "+faststart", out]
    return cmd, out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: transcode.py <file> [--dry-run]")
        sys.exit(1)

    src = sys.argv[1]
    dry = "--dry-run" in sys.argv
    cmd, out = build_cmd(src)

    info = probe(src)
    audio = next((s for s in info if s["codec_type"] == "audio"), {})
    print(f"  audio : {audio.get('codec_name','?')} {audio.get('channels','?')}ch → aac stereo {'(dplii downmix)' if int(audio.get('channels',2)) > 2 else ''}")
    print(f"  video : {'videotoolbox' if has_encoder('h264_videotoolbox') else 'libx264'}")
    print(f"  output: {out}")
    print(f"\n  cmd: {' '.join(cmd)}\n")

    if not dry:
        subprocess.run(cmd, check=True)
