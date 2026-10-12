#!/usr/bin/env python3
"""BILGI DOZU shorts pipeline — stages: plates | timing | music | render
Usage: python3 shorts_pipeline.py <stage> <video_id>
Stages:
  plates  - grade/crop bg images into 1620x2880 plates
  timing  - tighten VO pauses, word timings, caption chunks -> timing.json
  music   - tension bed sized to video duration
  render  - full 1080x1920x30fps MP4
  all     - plates+timing+music
"""
import contextlib, json, os, re, subprocess, sys, unicodedata, wave
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FF = open(os.path.join(ROOT, "ffmpeg_path.txt")).read().strip()
FDIR = os.path.join(ROOT, "fonts", "raw")
CONF = json.load(open(os.path.join(HERE, "shorts_config.json")))
W, H, FPS = 1080, 1920, 30
MX = 72
CW = W - 2 * MX
LEAD = 0.40
GREEN = (212, 255, 63, 255)
YELLOW = (255, 225, 74, 255)
WHITE = (255, 255, 255, 255)


# ---------------------------------------------------------------- utils
def N_(t):
    return unicodedata.normalize("NFC", t)


def draw_text(d, xy, txt, font, fill):
    d.text(xy, N_(txt), font=font, fill=fill, anchor="ls")


def wlen(d, txt, font):
    return d.textlength(N_(txt), font=font)


def load_font(name, size):
    return ImageFont.truetype(os.path.join(FDIR, name), size,
                              layout_engine=ImageFont.Layout.BASIC)


def ease_out(t):
    return 1 - (1 - min(max(t, 0), 1)) ** 3


def ease_io(t):
    t = min(max(t, 0), 1)
    return t * t * (3 - 2 * t)


def clamp01(v):
    return min(max(v, 0.0), 1.0)


def wav_dur(p):
    with contextlib.closing(wave.open(p)) as w:
        return w.getnframes() / float(w.getframerate())


def read_wav(p):
    with contextlib.closing(wave.open(p)) as w:
        fr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32767
    return x, fr


def write_wav(p, x, fr):
    with wave.open(p, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(fr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def ff_silences(p, noise_db=-36.0, mind=0.16):
    r = subprocess.run([FF, "-hide_banner", "-i", p, "-af",
                        f"silencedetect=noise={noise_db}dB:d={mind}", "-f", "null", "-"],
                       capture_output=True, text=True)
    log = r.stderr
    starts = [float(v) for v in re.findall(r"silence_start:\s*([0-9.]+)", log)]
    ends = [float(v) for v in re.findall(r"silence_end:\s*([0-9.]+)", log)]
    mm = re.search(r"Duration:\s*\d+:\d+:([0-9.]+)", log)
    d = float(mm.group(1)) if mm else 0.0
    out = list(zip(starts, ends))
    if len(starts) > len(ends):
        out.append((starts[-1], d))
    return out, d


def _resample(seg, n_out):
    if len(seg) == 0:
        return np.zeros(max(int(n_out), 1))
    idx = np.linspace(0, len(seg) - 1, max(int(n_out), 1))
    return np.interp(idx, np.arange(len(seg)), seg)


# ---------------------------------------------------------------- plates
def build_plate(src_path, out_path):
    src = Image.open(src_path).convert("RGB")
    PW, PH = 1620, 2880
    sc = max(PW / src.width, PH / src.height)
    nw, nh = int(src.width * sc + 0.5), int(src.height * sc + 0.5)
    img = src.resize((nw, nh), Image.LANCZOS)
    img = img.crop(((nw - PW) // 2, (nh - PH) // 2, (nw - PW) // 2 + PW, (nh - PH) // 2 + PH))
    img = ImageEnhance.Color(img).enhance(0.82)
    img = ImageEnhance.Contrast(img).enhance(1.10)
    img = ImageEnhance.Brightness(img).enhance(0.93)
    a = np.asarray(img).astype(np.float32) / 255.0
    a[..., 0] *= 0.94
    a[..., 2] = np.clip(a[..., 2] * 1.05 + 0.010, 0, 1)
    yy, xx = np.mgrid[0:PH, 0:PW]
    r = np.sqrt(((xx - PW / 2) / (PW * 0.62)) ** 2 + ((yy - PH / 2) / (PH * 0.60)) ** 2)
    a *= np.clip(1.0 - 0.38 * np.maximum(r - 0.55, 0) / 0.65, 0, 1)[..., None]
    a += np.random.default_rng(5).standard_normal((PH, PW, 1)).astype(np.float32) * 0.016
    img = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8), "RGB")
    img = img.filter(ImageFilter.UnsharpMask(radius=2.0, percent=45, threshold=2))
    ov = np.zeros((PH, PW), np.float32)
    ytop = int(PH * 0.34)
    ov[:ytop] = np.repeat((np.linspace(1, 0, ytop) ** 1.7 * 0.80)[:, None], PW, axis=1)
    ybot = int(PH * 0.46)
    y0 = PH - ybot
    ov[y0:] = np.repeat((np.linspace(0, 1, ybot) ** 1.6 * 0.86)[:, None], PW, axis=1)
    plate = np.asarray(img).astype(np.float32) / 255.0
    plate *= (1 - ov[..., None])
    Image.fromarray((plate * 255).astype(np.uint8), "RGB").save(out_path)


def stage_plates(vdir):
    cfg = CONF[vdir]
    names = list(cfg["scenes"])
    if names[1] == "bg2.png" and not os.path.exists(os.path.join(HERE, vdir, "bg2.png")):
        # derive scene 2 from scene 1 (flip + tighter crop + darker grade)
        im = Image.open(os.path.join(HERE, vdir, "bg1.png")).convert("RGB")
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
        pw, ph = im.size
        im = im.crop((int(pw * 0.10), int(ph * 0.06), int(pw * 0.90), int(ph * 0.86)))
        im = ImageEnhance.Brightness(im).enhance(0.88)
        im.save(os.path.join(HERE, vdir, "bg2.png"))
    for n in names:
        out = os.path.join(HERE, vdir, "plate_" + n)
        build_plate(os.path.join(HERE, vdir, n), out)
        print("plate:", out)


# ---------------------------------------------------------------- timing
def stage_timing(vdir):
    script = open(os.path.join(HERE, vdir, "script.txt"), encoding="utf-8").read().strip()
    raw = os.path.join(HERE, vdir, "vo_raw.wav")
    x, fr = read_wav(raw)
    sils, dur = ff_silences(raw)
    spans, prev = [], 0.0
    for s, e in sils:
        if s - prev > 0.30:
            spans.append((prev, s))
        prev = e
    if dur - prev > 0.30:
        spans.append((prev, dur))
    if not spans:
        spans = [(0.0, dur)]
    # tighten pauses x0.72 (min 0.14)
    KEEP, MINP = 0.72, 0.14
    head = min(spans[0][0], 0.30)
    pieces = [x[: int(head * fr)]]
    tmap = []
    nw_t = head
    for i, (a, b) in enumerate(spans):
        if i > 0:
            gap = a - spans[i - 1][1]
            ngap = max(MINP, gap * KEEP)
            pieces.append(_resample(x[int(spans[i - 1][1] * fr): int(a * fr)], ngap * fr))
            nw_t += ngap
        seg = x[int(a * fr): int(b * fr)]
        pieces.append(seg)
        tmap.append((a, b, nw_t, nw_t + (b - a)))
        nw_t += b - a
    pieces.append(x[int(spans[-1][1] * fr): int(dur * fr)])
    nw_t += dur - spans[-1][1]
    tight = np.concatenate(pieces)
    write_wav(os.path.join(HERE, vdir, "vo_final.wav"), tight, fr)
    scale = (len(tight) / fr) / dur
    tight_spans = [(a2 * scale, b2 * scale) for _, _, a2, b2 in tmap]
    tight_dur = len(tight) / fr
    print(f"{vdir}: raw {dur:.2f}s -> tight {tight_dur:.2f}s, spans {len(tight_spans)}")

    # sentences (for caption chunks) — split on .!? but keep trailing
    sents = [s for s in re.split(r"(?<=[.!?])\s+", script.strip()) if s]
    # char-weighted alignment of spans -> sentences (greedy proportional, ep01-style DP)
    chars = [len(s) for s in sents]
    tot = sum(chars) or 1
    speech = sum(b - a for a, b in tight_spans)
    exp = [speech * c / tot for c in chars]
    m, n = len(tight_spans), len(sents)
    INF = 1e18
    dp = [[INF] * (n + 1) for _ in range(m + 1)]
    bk = [[None] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = 0.0
    for i in range(1, m + 1):
        for j in range(1, min(i, n) + 1):
            for k in range(j - 1, i):
                if dp[k][j - 1] >= INF:
                    continue
                got = sum(b - a for a, b in tight_spans[k:i])
                v = dp[k][j - 1] + abs(got - exp[j - 1]) + 0.25 * (i - k - 1)
                if v < dp[i][j]:
                    dp[i][j] = v
                    bk[i][j] = k
    cuts, i, j = [], m, n
    while j > 0:
        k = bk[i][j]
        cuts.append((k, i))
        i, j = k, j - 1
    cuts.reverse()
    if i > 0:
        cuts[0] = (0, cuts[0][1])
    sent_spans = [(tight_spans[gi][0], tight_spans[gj - 1][1]) for gi, gj in cuts]

    # words per sentence (char-proportional) + chunks split at commas if long
    meas = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    f_cap = load_font("archivo.ttf", 50)
    chunks = []
    for si, (sent, (a, b)) in enumerate(zip(sents, sent_spans)):
        parts, cur = [], []
        for w_ in sent.split():
            cur.append(w_)
            if w_.endswith(",") and len(cur) >= 3:
                parts.append(" ".join(cur)); cur = []
        if cur:
            parts.append(" ".join(cur))
        # merge tiny parts into neighbors, cap 14 words
        merged = []
        for p in parts:
            if merged and (len(merged[-1].split()) < 4 or len(p.split()) > 14):
                merged[-1] += " " + p
            else:
                merged.append(p)
        while any(len(mm_.split()) > 14 for mm_ in merged):
            mm2 = []
            for mm_ in merged:
                ws = mm_.split()
                if len(ws) > 14:
                    mid = len(ws) // 2
                    mm2.append(" ".join(ws[:mid])); mm2.append(" ".join(ws[mid:]))
                else:
                    mm2.append(mm_)
            merged = mm2
        tot_parts = sum(len(p) for p in merged) or 1
        st = a
        for p in merged:
            span = (b - a) * len(p) / tot_parts
            words, wt = [], st
            for w_ in p.split():
                wd = span * len(w_) / len(p)
                words.append({"w": w_, "s": round(wt + LEAD, 3), "e": round(wt + wd + LEAD, 3)})
                wt += wd
            chunks.append({"text": p, "words": words,
                           "show": round(st + LEAD - 0.15, 3),
                           "hide": round(st + span + LEAD + 0.45, 3)})
            st += span
    # chunk hide capped by next chunk show
    for ci in range(len(chunks) - 1):
        chunks[ci]["hide"] = round(min(chunks[ci]["hide"], chunks[ci + 1]["show"] + 0.05), 3)
    last_end = chunks[-1]["words"][-1]["e"]
    for c in chunks:  # wrap rows once
        c["rows"] = wrap_rows(meas, c["words"], f_cap)

    vo_dur = tight_dur
    total = round(max(LEAD + vo_dur + 0.8, 35.2), 2)
    out = {"fps": FPS, "total": total, "vo_dur": round(vo_dur, 3),
           "vo_file": "vo_final.wav", "chunks": chunks, "last_end": last_end,
           "scene_switch": round(LEAD + vo_dur * 0.46, 2)}
    json.dump(out, open(os.path.join(HERE, vdir, "timing.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{vdir}: {len(chunks)} chunks, total {total}s, switch at {out['scene_switch']}s")


def wrap_rows(meas, words, font, maxw=None):
    maxw = maxw or (CW - 40)
    rows, cur, cw = [], [], 0
    for wd in words:
        ww = wlen(meas, wd["w"], font)
        if cur and cw + 14 + ww > maxw:
            rows.append(cur); cur, cw = [], 0
        cur.append((wd, ww))
        cw += ww + (14 if len(cur) > 1 else 0)
    if cur:
        rows.append(cur)
    return rows


# ---------------------------------------------------------------- music
def stage_music(vdir):
    tl = json.load(open(os.path.join(HERE, vdir, "timing.json")))
    DUR = tl["total"]
    SR = 44100
    Nn = int(SR * DUR)
    t = np.arange(Nn) / SR
    out = np.zeros(Nn)
    drone = np.sin(2 * np.pi * 55 * t) + 0.55 * np.sin(2 * np.pi * 55.4 * t) \
            + 0.22 * np.sin(2 * np.pi * 110 * t) + 0.10 * np.sin(2 * np.pi * 165 * t)
    out += 0.16 * drone * np.clip(t / 4.0, 0, 1) ** 1.5 * (0.82 + 0.18 * np.sin(2 * np.pi * 0.11 * t))
    bpm = 84.0
    eighth = 60.0 / bpm / 2
    rng = np.random.default_rng(9)

    def add(sig, start, gain=1.0):
        i0 = int(start * SR)
        if i0 >= Nn:
            return
        seg = sig[: Nn - i0]
        out[i0:i0 + len(seg)] += seg * gain

    for k in range(int(DUR / eighth)):
        s = k * eighth
        if s > DUR - 0.05:
            continue
        accent = 1.0 if k % 4 == 0 else 0.42
        n = int(0.35 * SR)
        tt = np.arange(n) / SR
        click = np.exp(-tt / 0.030) * np.sin(2 * np.pi * (150 + 260 * np.exp(-tt / 0.05)) * tt)
        if s < 1.9:
            accent *= 0.15
        elif s < 3.0:
            accent *= 0.45
        elif s >= DUR - 4.5:
            accent *= 1.5
        add(click, s, 0.075 * accent)
    noise = rng.standard_normal(Nn)
    lp = np.zeros(Nn); a_ = 0.65; acc = 0.0
    for i in range(Nn):
        acc = acc + a_ * (noise[i] - acc)
        lp[i] = acc
    hiss = noise - lp
    he = 0.010 + 0.012 * np.clip((t - 2.0) / 2.0, 0, 1)
    he *= 1 - 0.6 * np.clip((t - (DUR - 1.2)) / 1.0, 0, 1)
    out += hiss * he

    def riser(t0, t1, f0, f1, g):
        n = int((t1 - t0) * SR)
        if n <= 0:
            return
        tt = np.arange(n) / SR
        p = tt / (t1 - t0)
        f = f0 * (f1 / f0) ** p
        sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * (0.35 + 0.65 * p ** 2) + 0.5 * np.sin(4 * np.pi * np.cumsum(f) / SR) * p ** 3
        add(sig * np.linspace(0.15, 1.0, n), t0, g)
        add(rng.standard_normal(n) * p ** 2, t0, g * 0.5)

    riser(DUR - 4.6, DUR - 1.5, 180, 950, 0.055)

    def kick(t0, g=0.30):
        n = int(0.9 * SR)
        tt = np.arange(n) / SR
        f = 62 * (1 + 3.2 * np.exp(-tt / 0.055))
        add(np.exp(-tt / 0.28) * np.sin(2 * np.pi * np.cumsum(f) / SR), t0, g)

    def pluck(t0, freq, g=0.05):
        n = int(0.9 * SR)
        tt = np.arange(n) / SR
        e = np.exp(-tt / 0.27)
        sig = e * (np.sin(2 * np.pi * freq * tt) + 0.35 * np.sin(4 * np.pi * freq * tt) + 0.12 * np.sin(6 * np.pi * freq * tt))
        add(sig * np.clip(tt / 0.004, 0, 1), t0, g)

    kick(DUR - 1.5, 0.30)
    for i, f in enumerate([220.0, 261.63, 329.63]):
        pluck(DUR - 1.45 + 0.72 * i, f)
    out *= np.clip(t / 0.35, 0, 1)
    out *= 1 - 0.9 * np.clip((t - (DUR - 0.9)) / 0.9, 0, 1)
    out *= 0.86
    side = np.roll(out, 37) * 0.10
    st = np.stack([out + side, out - side], axis=1)
    st = np.tanh(st * 1.05)
    st /= np.max(np.abs(st)) * (1 / 0.88)
    p = os.path.join(HERE, vdir, "music.wav")
    with wave.open(p, "wb") as wf:
        wf.setnchannels(2); wf.setsampwidth(2); wf.setframerate(SR)
        wf.writeframes((st * 32767).astype(np.int16).tobytes())
    print("music:", p, f"{DUR:.2f}s")


# ---------------------------------------------------------------- render
F_TITLE = load_font("archivo.ttf", 92)
F_CAP = load_font("archivo.ttf", 50)
F_TAG = load_font("archivo.ttf", 30)
F_BRAND = load_font("archivo.ttf", 44)
F_NOTE = load_font("inter.ttf", 28, ) if False else None


def render_video(vdir):
    cfg = CONF[vdir]
    tl = json.load(open(os.path.join(HERE, vdir, "timing.json")))
    total = tl["total"]
    NF = int(total * FPS)
    plates = [Image.open(os.path.join(HERE, vdir, "plate_" + s)).convert("RGB") for s in cfg["scenes"]]
    meas = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    accents = {a.lower() for a in cfg["accents"]}
    brand_w = wlen(meas, "BİLGİ ", F_BRAND) + wlen(meas, "DOZU", F_BRAND)
    f_note = load_font("inter.ttf", 28)
    while wlen(meas, cfg["note1"], f_note) > CW:
        f_note = load_font("inter.ttf", f_note.size - 1)
    # per-video title font autofit
    global F_TITLE
    tsize = 92
    while tsize > 56:
        ft = load_font("archivo.ttf", tsize)
        ok = True
        for line in cfg["title"]:
            wsum = sum(wlen(meas, (sg if isinstance(sg, str) else sg[0]), ft) for sg in line)
            if wsum > CW - 14:
                ok = False
        if ok:
            break
        tsize -= 4
    F_TITLE = load_font("archivo.ttf", tsize)
    print(f"{vdir}: title font {tsize}px")
    lh_global = int(tsize * 1.36)
    out_mp4 = os.path.join(HERE, vdir, "video.mp4")
    mix = build_mix(vdir, total)
    cmd = [FF, "-y", "-hide_banner", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-i", mix, "-map", "0:v", "-map", "1:a",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-threads", "2", "-x264-params", "rc-lookahead=20", "-pix_fmt", "yuv420p",
           "-profile:v", "high", "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
           "-movflags", "+faststart", "-shortest", out_mp4]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for fi in range(NF):
        tsec = fi / FPS
        img = frame_bg(plates, tsec, tl, NF)
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        # progress bar
        p = clamp01(fi / (NF - 1))
        ybar, bh = 58, 6
        d.rounded_rectangle([MX, ybar, MX + CW, ybar + bh], radius=3, fill=(255, 255, 255, 52))
        fw = CW * p
        if fw > 6:
            glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow)
            gd.rounded_rectangle([MX, ybar - 3, MX + fw, ybar + bh + 3], radius=6, fill=(212, 255, 63, 110))
            ov.alpha_composite(glow.filter(ImageFilter.GaussianBlur(6)))
            d.rounded_rectangle([MX, ybar, MX + fw, ybar + bh], radius=3, fill=GREEN)
        # tag
        e_tag = ease_out(fi / 8)
        if e_tag > 0:
            a = int(255 * e_tag)
            tagw = wlen(d, "BİLGİ DOZU", F_TAG)
            d.rounded_rectangle([MX, 94, MX + 22 + tagw + 22, 94 + 52], radius=14, fill=(212, 255, 63, a))
            draw_text(d, (MX + 22, 94 + 40), "BİLGİ DOZU", F_TAG, (11, 15, 20, a))
        # headline
        base_y, lh = 300, lh_global
        for li, line in enumerate(cfg["title"]):
            e = ease_out((fi - 3 - li * 3) / 12)
            if e <= 0:
                continue
            a = int(255 * e)
            yb = base_y + li * lh - (1 - e) * 60
            x = MX
            if li == 0:
                d.rectangle([MX, yb - 75, MX + int(64 * e), yb - 63], fill=(212, 255, 63, a))
            for seg in line:
                txt, col = (seg, "w") if isinstance(seg, str) else seg
                fill = (212, 255, 63, a) if col == "g" else (255, 255, 255, a)
                draw_text(d, (x + 3, yb + 5), txt, F_TITLE, (0, 0, 0, int(a * 0.8)))
                draw_text(d, (x, yb), txt, F_TITLE, fill)
                x += wlen(d, txt + " ", F_TITLE)
        # captions (chunks)
        active = None
        for c in tl["chunks"]:
            if c["show"] <= tsec < c["hide"]:
                active = c
                break
        if active:
            e_in = ease_out((tsec - active["show"]) / 0.14)
            e_out = clamp01((active["hide"] - tsec) / 0.14)
            a = int(235 * e_in * e_out)
            dy = (1 - e_in) * 18
            k = -1
            for wi, wd in enumerate(active["words"]):
                if tsec >= wd["s"] - 0.02:
                    k = wi
            rows = active["rows"]
            rowh = 60
            by0 = 1160 - (len(rows) - 1) * rowh
            for ri, row in enumerate(rows):
                total_w = sum(ww for _, ww in row) + 14 * (len(row) - 1)
                x = (W - total_w) / 2
                yb = by0 + ri * rowh + dy
                for (wd, ww) in row:
                    idx = active["words"].index(wd)
                    is_acc = wd["w"].strip(".,!?:;'\"").lower() in accents
                    if idx == k:
                        col = YELLOW
                    elif idx < k:
                        col = YELLOW if is_acc else (255, 255, 255, a)
                        if is_acc:
                            col = YELLOW
                    else:
                        col = (255, 255, 255, int(a * 0.55))
                    if idx != k and is_acc and idx < k:
                        col = YELLOW
                    draw_text(d, (x + 2, yb + 4), wd["w"], F_CAP, (0, 0, 0, int(a * 0.75)))
                    draw_text(d, (x, yb), wd["w"], F_CAP, col)
                    x += ww + 14
        # note
        e_n = ease_out((fi - 16) / 12)
        if e_n > 0:
            a = int(175 * e_n)
            draw_text(d, ((W - wlen(d, cfg["note1"], f_note)) / 2 + 2, 1743), cfg["note1"], f_note, (0, 0, 0, int(a * 0.5)))
            draw_text(d, ((W - wlen(d, cfg["note1"], f_note)) / 2, 1738), cfg["note1"], f_note, (240, 244, 240, a))
            draw_text(d, ((W - wlen(d, cfg["note2"], f_note)) / 2 + 2, 1787), cfg["note2"], f_note, (0, 0, 0, int(a * 0.4)))
            draw_text(d, ((W - wlen(d, cfg["note2"], f_note)) / 2, 1782), cfg["note2"], f_note, (160, 170, 168, int(a * 0.8)))
        # brand
        e_b = ease_out((fi - 24) / 12)
        if e_b > 0:
            a = int(255 * e_b)
            x = (W - brand_w) / 2
            draw_text(d, (x + 3, 1873), "BİLGİ", F_BRAND, (0, 0, 0, int(a * 0.8)))
            draw_text(d, (x, 1868), "BİLGİ", F_BRAND, (255, 255, 255, a))
            x2 = x + wlen(d, "BİLGİ ", F_BRAND)
            draw_text(d, (x2 + 3, 1873), "DOZU", F_BRAND, (0, 0, 0, int(a * 0.8)))
            draw_text(d, (x2, 1868), "DOZU", F_BRAND, (212, 255, 63, a))
        frame = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
        proc.stdin.write(frame.tobytes())
        if fi % 150 == 0:
            print(f"{vdir} frame {fi}/{NF}", flush=True)
            frame.resize((270, 480), Image.LANCZOS).save(os.path.join(HERE, vdir, f"qc_{fi:04d}.jpg"), quality=88)
    proc.stdin.close()
    proc.wait()
    print("done:", out_mp4, proc.returncode)


def frame_bg(plates, tsec, tl, NF):
    sw = tl["scene_switch"]
    e = ease_io(tsec / max(tl["total"], 0.001))
    def warp(pl, z0, z1, cy_off):
        zz = z0 + (z1 - z0) * e
        sc = (pl.width / zz) / W
        return pl.transform((W, H), Image.AFFINE,
                            (sc, 0.0, pl.width / 2 - (W / 2) * sc,
                             0.0, sc, pl.height / 2 + cy_off - (H / 2) * sc),
                            resample=Image.BICUBIC)
    if len(plates) == 1 or tsec < sw - 0.3:
        return warp(plates[0], 1.030, 1.075, -30 * e)
    if tsec > sw + 0.3:
        return warp(plates[1], 1.080, 1.032, -40 * (1 - e))
    imgA = warp(plates[0], 1.030, 1.075, -30 * e)
    imgB = warp(plates[1], 1.080, 1.032, -40 * (1 - e))
    alpha = (tsec - (sw - 0.3)) / 0.6
    return Image.blend(imgA, imgB, clamp01(alpha))


def build_mix(vdir, total):
    mix = os.path.join(HERE, vdir, "mix.wav")
    cmd = [FF, "-y", "-hide_banner", "-loglevel", "error",
           "-i", os.path.join(HERE, vdir, "vo_final.wav"),
           "-i", os.path.join(HERE, vdir, "music.wav"),
           "-filter_complex",
           "[0:a]aformat=sample_rates=44100:channel_layouts=mono,"
           f"adelay={int(LEAD*1000)}|{int(LEAD*1000)},apad=whole_dur={total}[vo];"
           "[1:a]aformat=sample_rates=44100:channel_layouts=stereo[mus];"
           "[vo]pan=stereo|c0=c0|c1=c0,asplit=2[vos1][vos2];"
           "[mus][vos1]sidechaincompress=threshold=0.035:ratio=5:attack=25:release=450:makeup=1[duck];"
           "[vos2][duck]amix=inputs=2:duration=first:normalize=0:weights=1 0.9[mx];"
           f"[mx]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100,atrim=0:{total}[out]",
           "-map", "[out]", "-c:a", "pcm_s16le", mix]
    subprocess.run(cmd, check=True)
    return mix


def main():
    stage, vdir = sys.argv[1], sys.argv[2]
    if stage == "plates":
        stage_plates(vdir)
    elif stage == "timing":
        stage_timing(vdir)
    elif stage == "music":
        stage_music(vdir)
    elif stage == "render":
        render_video(vdir)
    elif stage == "publish":
        import publish
        publish.main([vdir] + sys.argv[3:])
    elif stage == "all":
        stage_plates(vdir); stage_timing(vdir); stage_music(vdir)
        render_video(vdir)
        import publish
        publish.main([vdir, "--simulate"])   # güvenli: all-modunda yüklemez


if __name__ == "__main__":
    main()
