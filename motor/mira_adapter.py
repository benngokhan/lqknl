#!/usr/bin/env python3
"""MIRA ADAPTER — Mira'nın motoru tek import ile kullanması için yapıştırma katmanı.

Kullanim (Mira kodu icinden):
    from mira_adapter import ingest_draft, render_short
    ingest_draft(draft_dict)                  # LLM ciktisini dosyalara doker
    sonuc = render_short("s12_ornek")         # timing+music+render+QC
    if sonuc["ok"]: ...                       # sonuc["video"] -> MP4 yolu

Teslim oncesi kanit:
    sonuc["qc"] = {"pass": True, "info": {...}}
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REQUIRED = ["video_id", "seo_title", "title_lines", "note1", "note2",
            "accents", "script", "description", "tags"]


def _py():
    return sys.executable or "python3"


def ensure_ffmpeg():
    """ffmpeg yolunu garanti et (imageio-ffmpeg ile)."""
    import tempfile
    p = os.path.join(tempfile.gettempdir(), "mira_motor_ffmpeg_path.txt")
    if os.path.exists(p):
        cand = open(p).read().strip()
        if os.path.exists(cand):
            return cand
    import imageio_ffmpeg
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(imageio_ffmpeg.get_ffmpeg_exe())
    return open(p).read().strip()


def ingest_draft(draft, shorts_dir=None):
    """LLM ciktisini (MIRA_SYSTEM_PROMPT semasi) motor dosyalarina doker."""
    missing = [k for k in REQUIRED if k not in draft]
    if missing:
        return {"ok": False, "error": f"eksik alanlar: {missing}"}
    sd = shorts_dir or os.path.join(HERE, "shorts")
    vd = os.path.join(sd, draft["video_id"])
    os.makedirs(vd, exist_ok=True)
    with open(os.path.join(vd, "script.txt"), "w", encoding="utf-8") as f:
        f.write(draft["script"].strip() + "\n")
    cfg_path = os.path.join(sd, "shorts_config.json")
    cfg = json.load(open(cfg_path, encoding="utf-8")) if os.path.exists(cfg_path) else {}
    cfg[draft["video_id"]] = {
        "title": draft["title_lines"],
        "note1": draft["note1"],
        "note2": draft["note2"],
        "accents": draft.get("accents", []),
        "seo_title": draft["seo_title"],
        "scenes": ["bg1.png", "bg2.png"],
        "youtube_meta": {"description": draft["description"], "tags": draft["tags"]},
    }
    json.dump(cfg, open(cfg_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return {"ok": True, "script": os.path.join(vd, "script.txt"),
            "config": cfg_path,
            "gorsel_beklenen": [os.path.join(vd, "bg1.png"), os.path.join(vd, "bg2.png")]}


def render_short(video_id, shorts_dir=None, lo=30.0, hi=60.0):
    """timing + music + render + QC. vo_raw.wav ve bg1/bg2 hazir olmali."""
    sd = shorts_dir or os.path.join(HERE, "shorts")
    vd = os.path.join(sd, video_id)
    ensure_ffmpeg()
    sorun = []
    if not os.path.exists(os.path.join(vd, "vo_raw.wav")):
        sorun.append("vo_raw.wav yok (TTS adımı çalışmadı)")
    for g in ("bg1.png", "bg2.png"):
        if not os.path.exists(os.path.join(vd, g)):
            sorun.append(f"{g} yok (görsel adımı çalışmadı)")
    if sorun:
        return {"ok": False, "error": "; ".join(sorun)}

    steps = [["all", video_id]]
    for st in steps:
        r = subprocess.run([_py(), os.path.join(HERE, "shorts_pipeline.py")] + st,
                           cwd=sd, capture_output=True, text=True)
        if r.returncode != 0:
            return {"ok": False, "error": f"pipeline {st} hata: {r.stderr[-800:]}"}

    video = os.path.join(vd, "video.mp4")
    r = subprocess.run([_py(), os.path.join(HERE, "qc_check.py"), video, str(lo), str(hi)],
                       cwd=HERE, capture_output=True, text=True)
    qc_pass = (r.returncode == 0)
    return {"ok": qc_pass, "video": video,
            "qc": {"pass": qc_pass, "cikti": (r.stdout + r.stderr)[-600:]}}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    print(json.dumps(render_short(sys.argv[1]), ensure_ascii=False, indent=1))
