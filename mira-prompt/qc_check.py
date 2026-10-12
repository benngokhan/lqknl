#!/usr/bin/env python3
"""BILGI DOZU QC kapi — kullanim: python3 qc_check.py video.mp4 [min_sure] [max_sure]
Cikti: PASS/FAIL + nedenler. Exit code: 0=PASS, 1=FAIL (job/ci uyumlu)."""
import re, shutil, subprocess, sys


def probe(args):
    return subprocess.run(args, capture_output=True, text=True)


def main():
    path = sys.argv[1]
    lo = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
    hi = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0
    fails = []

    ffprobe = shutil.which("ffprobe") or "ffprobe"
    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"

    # süre
    p = probe([ffprobe, "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", path])
    try:
        dur = float(p.stdout.strip())
    except ValueError:
        print("QC: FAIL ❌ -> dosya okunamadı"); sys.exit(1)
    if not (lo <= dur <= hi):
        fails.append(f"süre {dur:.1f}s (beklenen {lo}-{hi})")

    # streamler
    p = probe([ffprobe, "-v", "error", "-show_entries", "stream=codec_type",
               "-of", "csv=p=0", path])
    kinds = sorted(k.strip() for k in p.stdout.strip().splitlines() if k.strip())
    if kinds != ["audio", "video"]:
        fails.append(f"stream yapısı bozuk: {kinds}")

    # çözünürlük (dikey 9:16 kontrolü)
    p = probe([ffprobe, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height", "-of", "csv=p=0", path])
    wh = p.stdout.strip().split(",")
    if len(wh) == 2:
        w, h = int(wh[0]), int(wh[1])
        if h <= w:
            fails.append(f"yatay video: {w}x{h} (Shorts için dikey gerek)")

    # ses seviyesi + konuşma kanıtı (sessiz-WAV bombası taraması)
    p = probe([ffmpeg, "-hide_banner", "-i", path, "-map", "0:a",
               "-af", "ebur128", "-f", "null", "-"])
    m = re.search(r"I:\s*(-?[0-9.]+) LUFS", p.stderr)
    lra = re.search(r"Loudness range:\s*\n?\s*LRA:\s*(-?[0-9.]+) LU", p.stderr)
    lufs = float(m.group(1)) if m else -999.0
    lra_v = float(lra.group(1)) if lra else 0.0
    if lufs < -25:
        fails.append(f"SES YOK/çok düşük: {lufs} LUFS")
    if lra_v < 2:
        fails.append(f"konuşma dinamiği yok: LRA={lra_v}")

    print("QC:", "PASS ✅" if not fails else "FAIL ❌ -> " + "; ".join(fails))
    print(f"  süre={dur:.1f}s  streams={'+'.join(kinds)}  "
          f"çözünürlük={wh[0]}x{wh[1] if len(wh) == 2 else '?'}  "
          f"LUFS={lufs}  LRA={lra_v}")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
