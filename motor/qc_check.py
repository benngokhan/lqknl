#!/usr/bin/env python3
"""BILGI DOZU QC kapi v2 — saf ffmpeg (ffprobe GEREKMEZ, imageio-ffmpeg ile calisir).

Kullanim:
  python3 qc_check.py video.mp4 [min_sure] [max_sure]   -> PASS/FAIL + exit 0/1
  python3 qc_check.py --selftest                        -> aracin kendini testi (CI icin)

Kontroller: sure bandi, video+audio stream, dikey yonelim, LUFS (> -25),
LRA (> 2 = konusma dinamiği kaniti, sessiz-WAV bombası taramasi).
"""
import re, shutil, subprocess, sys, tempfile, os


def ffmpeg_bin():
    envn = os.environ.get("MIRA_MOTOR_FFMPEG")
    if envn and os.path.exists(envn):
        return envn
    tf = os.path.join(tempfile.gettempdir(), "mira_motor_ffmpeg_path.txt")
    if os.path.exists(tf) and os.path.exists(open(tf).read().strip()):
        return open(tf).read().strip()
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg_path.txt")
    if os.path.exists(p):
        try:
            bin_ = open(p).read().strip()
            if os.path.exists(bin_):
                return bin_
        except Exception:
            pass
    env = shutil.which("ffmpeg")
    if env:
        return env
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def media_info(ff, path):
    r = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True)
    log = r.stderr
    dur_m = re.search(r"Duration:\s*\d+:\d+:([0-9.]+)", log)
    dur = float(dur_m.group(1)) if dur_m else 0.0
    kinds = sorted(set(re.findall(r"Stream #0:\d+.*?:\s*(Video|Audio):", log)))
    res_m = re.search(r"Video:.*?,\s*(\d+)x(\d+)[,\s]", log)
    res = (int(res_m.group(1)), int(res_m.group(2))) if res_m else (0, 0)
    return dur, kinds, res


def loudness(ff, path):
    r = subprocess.run([ff, "-hide_banner", "-i", path, "-map", "0:a",
                        "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    log = r.stderr
    m = re.findall(r"I:\s*(-?[0-9.]+) LUFS", log)
    lra = re.findall(r"LRA:\s*(-?[0-9.]+) LU", log)
    # entegre (final) degerler sondaki ozet bloğundadir
    lufs = float(m[-1]) if m else -999.0
    lra_v = float(lra[-1]) if lra else 0.0
    return lufs, lra_v


def check(path, lo=30.0, hi=60.0, quiet=False):
    ff = ffmpeg_bin()
    fails = []
    dur, kinds, (w, h) = media_info(ff, path)
    if dur == 0:
        return False, ["dosya okunamadı"], {}
    if not (lo <= dur <= hi):
        fails.append(f"süre {dur:.1f}s (beklenen {lo}-{hi})")
    if kinds != ["Audio", "Video"]:
        fails.append(f"stream yapısı bozuk: {kinds}")
    if h <= w:
        fails.append(f"yatay video: {w}x{h} (Shorts dikey gerek)")
    lufs, lra_v = loudness(ff, path)
    if lufs < -25:
        fails.append(f"SES YOK/çok düşük: {lufs} LUFS (sessiz-WAV bombası)")
    if lra_v < 2:
        fails.append(f"konusma dinamiği yok: LRA={lra_v}")
    info = {"sure": round(dur, 2), "streams": "+".join(kinds),
            "cozunurluk": f"{w}x{h}", "LUFS": lufs, "LRA": lra_v}
    if not quiet:
        print("QC:", "PASS ✅" if not fails else "FAIL ❌ -> " + "; ".join(fails))
        print("  " + "  ".join(f"{k}={v}" for k, v in info.items()))
    return (not fails), fails, info


def selftest():
    """Aracın kendini dogrulamasi: gecerli klip PASS, sessiz klip FAIL olmali."""
    ff = ffmpeg_bin()
    tmp = tempfile.mkdtemp(prefix="qc_selftest_")
    ok_all = True

    def gen(out, audio_filter):
        subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30",
                        "-f", "lavfi", "-i", "sine=frequency=210",
                        "-t", "32", "-af", audio_filter,
                        "-c:v", "libx264", "-preset", "ultrafast",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", out], check=True)

    # 1) konusma benzeri (acik/kapak ses) -> PASS beklenir
    good = os.path.join(tmp, "good.mp4")
    gen(good, "volume='if(lt(mod(t,6),3),0.9,0.08)':eval=frame")
    g_ok, g_fails, g_info = check(good, quiet=True)
    print(f"  selftest/gecerli-klip : {'PASS ✅' if g_ok else 'FAIL ❌ ' + str(g_fails)}  {g_info}")
    ok_all &= g_ok

    # 2) sessiz klip -> FAIL beklenir (arac sessizligi yakalamali)
    bad = os.path.join(tmp, "bad.mp4")
    gen(bad, "volume=0")
    b_ok, b_fails, b_info = check(bad, quiet=True)
    caught = (not b_ok) and any("SES YOK" in f for f in b_fails)
    print(f"  selftest/sessiz-klip  : {'yakalandı ✅' if caught else 'KAÇTI ❌ ' + str(b_fails)}")
    ok_all &= caught

    print("SELFTEST:", "PASS ✅ (QC kapısı sağlam)" if ok_all else "FAIL ❌")
    return 0 if ok_all else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(selftest())
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    lo = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
    hi = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0
    ok, _, _ = check(sys.argv[1], lo, hi)
    sys.exit(0 if ok else 1)
