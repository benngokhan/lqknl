#!/usr/bin/env python3
"""BILGI DOZU — KANAL NABZI (channel pulse)
Kanalın son Shorts'larını çeker, konu kümelerine ayırır, hangi kategori
sinyal aldığını raporlar ve MİRA'YA İÇERİK DİREKTİFİ üretir.

Kullanım:
  python3 channel_pulse.py --handle @bilgidozu --key API_ANAHTARI
  python3 channel_pulse.py --channel UCxxxx --key API_ANAHTARI --top 20
  python3 channel_pulse.py --handle @bilgidozu --key KEY --config shorts_config.json

Çıktı:
  pulse_report.json    → ham veri (video bazlı metrikler + kümeler)
  content_directive.md → Mira'ya yapıştırılacak/eklenecek İÇERİK DİREKTİFİ

Kota maliyeti: ~3-5 birim (günlük 10.000'in binde kaçı). Haftada 1 koşmak yeter.
"""
import argparse, json, os, re, sys, urllib.parse, urllib.request
from datetime import datetime, timezone

API = "https://www.googleapis.com/youtube/v3"

# ---- konu kümeleri (anahtar kelime tabanlı; config'in note1/seo'su da kullanılır)
CLUSTERS = {
    "hafıza_anı":       ["anı", "anıl", "hafıza", "bellek", "hatırla", "unut", "yazılıyor"],
    "beyin_fizik":      ["watt", "enerji", "ampul", "20 watt", "super", "bilgisayar"],
    "vücut_bilim":      ["bağırsak", "karnınız", "ağrı", "serotonin", "uyurken", "yıkanıyor", "uyku"],
    "algı_dikkat":      ["goril", "odaklan", "dikkat", "algı", "kör", "göremez"],
    "zaman_beyin":      ["zaman", "deja", "saat", "yoğunlaş"],
    "günlük_paradoks":  ["kapı", "odaya", "girdiğinizi", "günlük", "telefon", "niçin", "niye"],
    "tarih_kıyas":      ["kleopatra", "piramit", "maraton", "iphone", "tarih"],
    "hayvan_dolu":      ["köpekbalık", "gorila", "hayvan", "doğa"],
}


def api_get(path, params, key):
    p = dict(params)
    p["key"] = key
    url = f"{API}/{path}?" + urllib.parse.urlencode(p)
    req = urllib.request.Request(url, headers={"User-Agent": "bilgi-dozu-pulse/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def parse_iso_dur(s):
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)


def resolve_channel(handle_or_id, key):
    h = handle_or_id.strip()
    if h.startswith("UC") and len(h) == 24:
        return h
    handle = h if h.startswith("@") else "@" + h
    r = api_get("channels", {"part": "id,snippet",
                             "forHandle": handle}, key)
    items = r.get("items", [])
    if not items:
        sys.exit(f"Kanal bulunamadı: {handle}")
    print(f"kanal: {items[0]['snippet']['title']}  ({items[0]['id']})")
    return items[0]["id"]


def fetch_shorts(channel_id, key, limit=20, max_seconds=61):
    ch = api_get("channels", {"part": "contentDetails", "id": channel_id}, key)
    up = ch["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
    vids, page = [], None
    while len(vids) < limit:
        params = {"part": "contentDetails", "playlistId": up,
                  "maxResults": min(50, limit - len(vids))}
        if page:
            params["pageToken"] = page
        r = api_get("playlistItems", params, key)
        vids += [i["contentDetails"]["videoId"] for i in r.get("items", [])]
        page = r.get("nextPageToken")
        if not page:
            break
    rows = []
    for i in range(0, len(vids), 50):
        chunk = vids[i:i + 50]
        r = api_get("videos", {"part": "snippet,statistics,contentDetails",
                               "id": ",".join(chunk)}, key)
        for it in r.get("items", []):
            dur = parse_iso_dur(it["contentDetails"].get("duration", ""))
            if dur == 0 or dur > max_seconds:      # sadece Shorts
                continue
            st = it.get("statistics", {})
            views = int(st.get("viewCount", 0))
            likes = int(st.get("likeCount", 0))
            comments = int(st.get("commentCount", 0))
            sn = it["snippet"]
            rows.append({
                "video_id": it["id"],
                "title": sn.get("title", ""),
                "published": sn.get("publishedAt", "")[:10],
                "views": views,
                "likes": likes,
                "comments": comments,
                "engagement": round((likes + comments) / views, 4) if views else 0,
                "age_days": max(1, (datetime.now(timezone.utc) -
                                    datetime.fromisoformat(
                                        sn["publishedAt"].replace("Z", "+00:00"))
                                    ).days),
                "views_per_day": round(views / max(1, (datetime.now(timezone.utc) -
                                    datetime.fromisoformat(
                                        sn["publishedAt"].replace("Z", "+00:00"))
                                    ).days)),
            })
    return rows


def _match(tokens, kws):
    # Türkçe ekler: anahtar kelime, kelimenin KÖKÜ olarak eşleşir (anı -> anılara ✓,
    # ama "yıkanıyor" içindeki "anı" dizisi eşleşmez çünkü kelime kökü "yık")
    for kw in kws:
        if len(kw) < 3:
            continue
        for tok in tokens:
            if tok.startswith(kw):
                return True
    return False


def classify(rows, cfg_path=None):
    cfg = {}
    try:
        if cfg_path and os.path.exists(cfg_path):
            cfg = json.load(open(cfg_path, encoding="utf-8"))
    except Exception:
        cfg = {}
    for row in rows:
        text = row["title"].lower()
        for v in cfg.values():
            if v.get("youtube_video_id") == row.get("video_id"):
                text += " " + (v.get("seo_title", "") + " " + v.get("note1", "")).lower()
        tokens = re.findall(r"[a-zçğıöşü0-9]{3,}", text)
        cluster = "diğer"
        for c, kws in CLUSTERS.items():
            if _match(tokens, kws):
                cluster = c
                break
        row["cluster"] = cluster
    return rows


def pct(v, base):
    return round(100 * v / base, 1) if base else 0


def build_directive(rows, clusters):
    med = sorted(r["views"] for r in rows)
    n = len(med)
    median = med[n // 2] if n else 0
    lines = ["# SİNYAL DİREKTİFİ — Mira içerik ağırlıkları",
             f"_Üretim: {datetime.now(timezone.utc).date()} • {n} Shorts analiz edildi • "
             f"medyan görüntülenme: {median:,}_", ""]
    lines += ["## Küme performansı", "",
              "| Küme | Video | Görüntülenme (toplam) | Medyan | Etkileşim % | Sinyal |",
              "|---|---|---|---|---|---|"]
    scores = []
    for c, items in sorted(clusters.items(), key=lambda kv: -sorted(
            (r["views"] for r in kv[1]), default=0)[-1] if kv[1] else 0):
        vs = sorted(r["views"] for r in items)
        cmed = vs[len(vs) // 2]
        eng = sum(r["engagement"] for r in items) / len(items) * 100
        signal = "🔴 ZAYIF" if cmed < median * 0.5 else (
            "🟡 NORMAL" if cmed < median * 1.5 else "🟢 GÜÇLÜ")
        scores.append((c, cmed, signal))
        lines.append(f"| {c} | {len(items)} | {sum(vs):,} | {cmed:,} | {eng:.1f} | {signal} |")
    strong = [c for c, m, s in scores if s.startswith("🟢")]
    weak = [c for c, m, s in scores if s.startswith("🔴")]
    outliers = [r for r in rows if r["views"] > max(median * 2, 500)]
    lines += ["", "## KARARLAR", ""]
    if strong:
        lines += [f"- ✅ **AĞIRLIK ARTIR ({', '.join(strong)}):** sonraki 5 taslağın "
                  f"en az 3'ü bu kümelerden olsun."]
    if weak:
        lines += [f"- ⛔ **DUR/AZALT ({', '.join(weak)}):** bu kümelerde yeni taslak "
                  f"üretme; format değişikliği olmadan dönüş yok."]
    if outliers:
        lines += ["- 🚀 **AYKIRI DEĞERLER (medyanın 2 katı üstü) — klonla:**"]
        lines += [f"  - `{r['video_id']}` {r['title']} ({r['views']:,} görüntülenme, "
                  f"küme: {r['cluster']}, etkileşim: %{r['engagement'] * 100:.1f})" for r in outliers]
    lines += ["", "## MİRA'YA İNJECT EDİLECEK BLOK", "", "```json",
              json.dumps({
                  "donem": datetime.now(timezone.utc).date().isoformat(),
                  "medyan_goruntulenme": median,
                  "agirlik_artir": strong,
                  "azalt_durdur": weak,
                  "klonlanacak_videolar": [r["video_id"] for r in outliers],
                  "yonerge": "Sonraki taslakların en az %60'ı güçlü kümelerden konu seçsin; "
                             "zayıf kümelerden taslak üretme. Aykırı videoların KANCAsını "
                             "(ilk cümle yapısını) yeni konularda taklit et."
              }, ensure_ascii=False, indent=1), "```"]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--handle")
    g.add_argument("--channel")
    ap.add_argument("--key", required=True, help="YouTube Data API v3 anahtarı")
    ap.add_argument("--top", type=int, default=20, help="analiz edilecek son video sayısı")
    ap.add_argument("--config", default="shorts_config.json")
    ap.add_argument(
        "--push-url",
        default=os.environ.get("MIRA_SIGNAL_PUSH_URL"),
        help="Opsiyonel Mira temel URL'si; verilirse direktif /api/automation/signal adresine gönderilir",
    )
    args = ap.parse_args()

    cid = resolve_channel(args.handle or args.channel, args.key)
    rows = fetch_shorts(cid, args.key, args.top)
    if not rows:
        sys.exit("Shorts bulunamadı")
    rows = classify(rows, args.config)
    clusters = {}
    for r in rows:
        clusters.setdefault(r["cluster"], []).append(r)
    rows.sort(key=lambda r: -r["views"])
    report = {"uretim": datetime.now(timezone.utc).isoformat(),
              "kanal": cid, "video_sayisi": len(rows),
              "medyan_views": sorted(r["views"] for r in rows)[len(rows) // 2],
              "videolar": rows, "kumeler": {
                  c: {"adet": len(v), "toplam_views": sum(x["views"] for x in v),
                      "medyan_views": sorted(x["views"] for x in v)[len(v) // 2],
                      "ort_engagement_pct": round(
                          100 * sum(x["engagement"] for x in v) / len(v), 2)}
                  for c, v in clusters.items()}}
    json.dump(report, open("pulse_report.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    directive = build_directive(rows, clusters)
    open("content_directive.md", "w", encoding="utf-8").write(directive)
    print(directive)
    print("\n📝 pulse_report.json + content_directive.md yazıldı.")

    if args.push_url:
        push_key = os.environ.get("MIRA_AUTOMATION_SECRET") or os.environ.get("MIRA_N8N_SECRET")
        if not push_key:
            sys.exit("Direktif dosyaları yazıldı, ancak MIRA_AUTOMATION_SECRET/MIRA_N8N_SECRET tanımlı olmadığı için Mira'ya gönderilmedi.")
        match = re.search(r"```json\s*(\{.*?\})\s*```", directive, re.DOTALL)
        if not match:
            sys.exit("Direktif dosyaları yazıldı, ancak JSON direktif bloğu ayrıştırılamadı.")
        payload = json.dumps({
            "directive": json.loads(match.group(1)),
            "source": "channel_pulse.py",
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            args.push_url.rstrip("/") + "/api/automation/signal",
            data=payload,
            headers={"Content-Type": "application/json", "x-mira-key": push_key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as response:
                result = json.load(response)
            if not result.get("ok"):
                sys.exit("Mira API direktifi kabul etmedi: " + str(result)[:500])
            print(f"✅ Mira'ya sinyal direktifi gönderildi. Kayıt: {result.get('operationId')}")
        except Exception as exc:
            sys.exit("Direktif dosyaları üretildi ama Mira API'ye gönderilemedi: " + str(exc)[:500])
    else:
        print("ℹ️ Otomatik aktarım ayarlı değil; direktif yalnızca dosyaya yazıldı. "
              "MIRA_SIGNAL_PUSH_URL ve MIRA_AUTOMATION_SECRET tanımlandığında Mira'ya gönderilebilir.")


if __name__ == "__main__":
    main()
