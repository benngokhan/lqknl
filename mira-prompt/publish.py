#!/usr/bin/env python3
"""BILGI DOZU — YouTube Shorts otomatik yayınlama.

Kullanım:
  python3 publish.py <video_id> [--privacy unlisted]           # gerçek yükleme
  python3 publish.py <video_id> --simulate                     # kuru koşu (yüklemez)
  python3 shorts_pipeline.py publish <video_id> [--simulate]   # pipeline üzerinden

Kimlik doğrulama:
  - client_secrets.json (Google Cloud OAuth "Desktop app" anahtarı) bu klasöre konur
  - İlk çalıştırmada tarayıcıdan onay alınır, token.json'a kaydedilir
  - Test modundaki Google projelerinde token 7 günde bir yenilenir
"""
import argparse, json, os, re, shutil, subprocess, sys, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_ff():
    p = os.path.join(os.path.dirname(HERE), "ffmpeg_path.txt")
    if os.path.isfile(p):
        try:
            configured = open(p, encoding="utf-8").read().strip()
            if configured:
                return configured
        except OSError:
            pass
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


FF = _find_ff()
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
CLIENT_SECRETS = os.path.join(HERE, "client_secrets.json")
TOKEN = os.path.join(HERE, "token.json")
CATEGORY_ID = "27"          # Education
DEFAULT_PRIVACY = "unlisted"

BASE_TAGS = ["shorts", "bilgi", "bilgi dozu", "biliyormuydun", "ilginç bilgiler",
             "bilgi yarışması", "öğretici", "keşfet", "öneri", "viral", "fyp",
             "bilgifacts", "biliyormusun", "enteresan"]

TOPIC_TAGS = {
    "s1_memory": ["hafıza", "bellek", "anılar", "beyin", "nörobilim", "psikoloji",
                  "nöroloji", "unutmak"],
    "s2_nopain": ["beyin", "ağrı", "cerrahi", "tıp", "nöroloji", "ameliyat",
                  "sağlık", "insan vücudu"],
    "s3_watt":   ["beyin", "enerji", "bilgisayar", "teknoloji", "nörobilim",
                  "verimlilik", "uyku", "bilim"],
    "s4_gut":    ["bağırsak", "mide", "sağlık", "beslenme", "serotonin",
                  "mikrobiyom", "psikoloji", "vücut"],
    "s5_door":   ["hafıza", "unutkanlık", "psikoloji", "beyin", "odalar",
                  "dikkat", "alışkanlıklar", "günlük hayat"],
}


def nfkc(s):
    return unicodedata.normalize("NFC", s or "").strip()


def load_video_data(video_id):
    cfg = json.load(open(os.path.join(HERE, "shorts_config.json"), encoding="utf-8"))[video_id]
    script = open(os.path.join(HERE, video_id, "script.txt"), encoding="utf-8").read().strip()
    timing = json.load(open(os.path.join(HERE, video_id, "timing.json"), encoding="utf-8"))
    # config başlığındaki renk işaretlerini temizle -> "ANILARINIZ HER HATIRLAYIŞTA YENİDEN YAZILIYOR"
    words = []
    for line in cfg["title"]:
        for seg in line:
            words.append(seg if isinstance(seg, str) else seg[0])
    raw_title = " ".join(words)
    return cfg, script, timing, raw_title


def build_title(raw_title, seo_title=None):
    if seo_title:
        t = nfkc(seo_title)
    else:
        t = nfkc(raw_title)
    t = t.capitalize() if t.isupper() else t[0].upper() + t[1:]
    if not t.endswith(("!", "?", ".")):
        t += "!"
    suffix = " 🧠 #Shorts"
    if len(t) + len(suffix) <= 100:
        t += suffix
    return t[:100]


def build_description(script, cfg):
    sentences = re.split(r"(?<=[.!?])\s+", script)
    hook = " ".join(sentences[:2])[:400]
    cta = "📌 Daha fazla bilgi dozu için kanala abone ol!"
    src = f"📚 Kaynak: {nfkc(cfg['note2'])}"
    fact = f"💡 {nfkc(cfg['note1'])}"
    return f"{hook}\n\n{fact}\n{src}\n{cta}"


def build_hashtags(video_id, raw_title):
    pool = list(dict.fromkeys(BASE_TAGS + TOPIC_TAGS.get(video_id, [])))
    for w in re.findall(r"[A-Za-zÇĞİÖŞÜçğıöşü]{5,}", raw_title.lower()):
        pool.append(w)
    seen, tags = {"#shorts"}, ["#Shorts"]
    for p in pool:
        tag = "#" + re.sub(r"[^a-z0-9çğıöşü]", "", p.lower())
        if tag != "#" and tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags[:15]


def probe_duration(path):
    try:
        r = subprocess.run([FF, "-hide_banner", "-i", path], capture_output=True, text=True)
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
        if not m:
            return None
        hours, minutes, seconds = int(m.group(1)), int(m.group(2)), float(m.group(3))
        return hours * 3600 + minutes * 60 + seconds
    except Exception:
        return None


def validate_video(path):
    problems = []
    if not os.path.exists(path):
        problems.append(f"video yok: {path}  (dosyayı bu klasöre video.mp4 olarak koy)")
        return problems, None
    try:
        r = subprocess.run([FF, "-hide_banner", "-i", path], capture_output=True, text=True)
        if "Video: h264" not in r.stderr:
            problems.append("kodek H.264 değil (YouTube yine de kabul eder ama önerilmez)")
    except Exception:
        pass
    dur = probe_duration(path)
    if dur and dur > 60.5:
        problems.append(f"süre {dur:.1f}s > 60s (Shorts sınırı)")
    return problems, dur


def build_payload(video_id, privacy):
    cfg, script, timing, raw_title = load_video_data(video_id)
    title = build_title(raw_title, cfg.get("seo_title"))
    desc = build_description(script, cfg)
    tags = build_hashtags(video_id, raw_title)
    hashtags_in_desc = " ".join(tags[:5])
    body = {
        "snippet": {
            "title": title,
            "description": desc + "\n\n" + hashtags_in_desc,
            "tags": [t.lstrip("#") for t in tags],
            "categoryId": CATEGORY_ID,
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }
    return body, {
        "video_file": os.path.join(HERE, video_id, "video.mp4"),
        "duration": timing.get("total"),
        "raw_title": raw_title,
        "hashtags": tags,
    }


def get_youtube_service():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    creds = None
    if os.path.exists(TOKEN):
        creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        elif os.path.exists(CLIENT_SECRETS):
            flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRETS, SCOPES)
            creds = flow.run_local_server(port=0)
        else:
            sys.exit("HATA: client_secrets.json yok. README_PUBLISH.md'yi oku.\n"
                     "(Şimdilik --simulate ile metadata üretebilirsin.)")
        with open(TOKEN, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
    return build("youtube", "v3", credentials=creds)


def upload(video_path, body):
    from googleapiclient.http import MediaFileUpload
    yt = get_youtube_service()
    media = MediaFileUpload(video_path, chunksize=8 * 1024 * 1024, resumable=True,
                            mimetype="video/mp4")
    req = yt.videos().insert(part="snippet,status", body=body, media_body=media)
    print("⬆️  Yükleniyor...")
    response = None
    while response is None:
        status, response = req.next_chunk()
        if status:
            print(f"   %{int(status.progress() * 100)}", end="\r", flush=True)
    vid = response.get("id")
    if not vid:
        print("\nAPI yanıtı:", json.dumps(response, indent=1, ensure_ascii=False))
        sys.exit("HATA: video id dönmedi (kota/audit kilidi olabilir).")
    print(f"\n✅ Yayınlandı: https://youtu.be/{vid}  ({body['status']['privacyStatus']})")
    return vid


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("video_id")
    ap.add_argument("--privacy", default=DEFAULT_PRIVACY,
                    choices=["public", "unlisted", "private"])
    ap.add_argument("--simulate", action="store_true",
                    help="yükleme yapmaz; metadata + doğrulama çıktısı verir")
    args = ap.parse_args(argv)

    body, meta = build_payload(args.video_id, args.privacy)
    problems, dur = validate_video(meta["video_file"])

    print("=" * 62)
    print(f"VIDEO      : {args.video_id}  ({meta['duration']}s / dosya {round(dur,1) if dur else '-'}s)")
    print(f"BAŞLIK ({len(body['snippet']['title'])} kr):\n  {body['snippet']['title']}")
    print(f"AÇIKLAMA:\n  {body['snippet']['description']}")
    print(f"HASHTAG ({len(meta['hashtags'])}):\n  {' '.join(meta['hashtags'])}")
    print(f"GİZLİLİK  : {body['status']['privacyStatus']}")
    print("=" * 62)
    if problems:
        print("⚠️  UYARILAR:")
        for p in problems:
            print("  -", p)

    if args.simulate:
        print("🟡 SİMÜLASYON: yükleme yapılmadı. Payload:")
        print(json.dumps(body, indent=1, ensure_ascii=False))
        return 0
    if problems:
        print("⛔ GÜVENLİK: Video doğrulama uyarıları bulunduğu için gerçek yükleme engellendi.")
        return 1
    upload(meta["video_file"], body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
