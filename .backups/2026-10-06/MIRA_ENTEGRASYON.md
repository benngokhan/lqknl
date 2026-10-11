# MİRA × BİLGİ DOZU MOTORU — ENTİGRASYON REHBERİ
(Bu workspace'te 10 video üretmiş, çalışır pipeline'ın Mira'ya port planı)

---

## 1) ELEŞTİRİ: MİRA'NIN EN KIRILGAN 6 NOKTASI

### 🔴 1. MP4 render (senin de dediğin gibi "test edilmedi") = zincirin son halkası
Bu işi bu workspace'te canlı yapmış biri olarak patlayan 3 bombam:
- **Sessiz ses bombası:** WAV yazarken `int16`'ya çevirirken ×32767 çarpanı unutulursa
  seslendirme DOSYAYA YAZILIR ama içerik tamamen SIFIR olur (−70 LUFS sessizlik).
  Video "başarılı" görünür, kullanıcı fark etmez, kanala boş video gider.
  → Çözüm: her render sonrası OTOMATİK probe: `LUFS > -25` ve `LRA > 2` değilse işi REDDET.
- **Türkçe glif bombası:** Pillow'un varsayılan raqm/HarfBuzz motoru büyük puntoda
  Türkçe birleşik glifleri (İ, Ğ, Ş, Ö) bozuyor/alt learn harfleri düşürüyor.
  → Çözüm: `ImageFont.truetype(..., layout_engine=ImageFont.Layout.BASIC)` ZORUNLU
  + Archivo Black kullan (Anton Türkçe glifleri titrek çıkarıyordu).
- **RAM bombası:** ffmpeg x264 `medium` preset 1080x1920'de 1.9GB RAM'de OOM kill
  yiyor (BrokenPipe, sebepsiz görünür).
  → Çözüm: `-preset veryfast -threads 2 -x264-params rc-lookahead=20`.
  Railway varsayılan dyno RAM'ini kontrol et; 512MB ise render'i ayrı worker'a al.

### 🟠 2. Halüsinasyon = kanal ölümü
"Gerçek" uyduran bilgi kanalı bir videoda itibarını kaybeder. Mira'nın analiz
raporundaki "DOĞRULAMA GEREKLİ" kolonu doğru fikir ama elle bakılıyorsa ölçeklenmez.
→ KURAL: LLM her gerçek için (kaynak: dergi + yıl + DOI/URL) vermek ZORUNDA;
kaynak bulamadığı taslak otomatik RED. Web araması adımı ekle (perplexity/serp/tavily
API'lerinden biri) ve taslağı kaynağa karşı kontrol ettir.

### 🟠 3. Tam otomatik YouTube yayını — ilk fazda KAPALI kalmalı
- YouTube API audit'ten geçmemiş projede yüklenen videolar PRIVATE kilide düşer.
- Günlük kota: 10.000 birim, 1 yükleme 1.600 → **~6 yükleme/gün** (3-4 hedefine uyar ama payı yok).
- Hatalı bir video public kanalda yayındayken düzeltilemez (Shorts cache'i hızlı).
→ İLK 2 HAFTA: onay kuyruğu YARI-otomatik (taslak → tek tık onay → otomatik yükle).
Mira'da zaten onay sistemi var; sadece "otomatik public"'i şimdilik kapat.

### 🟡 4. Marka tutarlılığı (günlük üretimde en çok bozulan şey)
Her videoda farklı font/renk/altyazı stili = marka oluşmaz.
→ Tüm görsel sabitler TEK config'ten (shorts_config.json yaklaşımı):
  font, renkler (#D4FF3F yeşil, sarı vurgu), etiket, ilerleme çubuğu, kaynak notu,
  marka imzası, altyazı stili. LLM sadece İÇERİĞİ üretir (başlık, senaryo, vurgu
  kelimeleri, görsel promptları) — Tasarımı hiçbir zaman LLM'e bırakma.

### 🟡 5. Görsel/TTS limitler ve maliyet matematiği (3-4 video/gün için)
- Görsel: video başına 2-3 sahne yeter (ben 2 kullanıyorum). 10 çağrı değil.
- TTS: ElevenLabs karakter limiti pahalıya gelir; Edge TTS ücretsiz ama tek ses.
  Karma strateji: taslak onayına kadar Edge TTS önizleme, onaydan sonra ElevenLabs final.
- Render süresi: veryfast ile ~5-8 dk/video. 4 video ≈ 30 dk CPU — Railway dyno için OK.

### 🟡 6. Kuyruk hata yönetimi
Bir video render'da patlarsa günlük hedef çöker.
→ Her adım job'ı 2 retry + başarısızsa günü özetleyen rapor (Telegram/mail) —
  "bugün 3/4 üretildi, şu video şu yüzden reddedildi".

---

## 2) ÖNERİLEN AKIŞ (Mira pipeline'ı)

```
[1] KONU ARAŞTIRMA (LLM + web arama)
    çıktı: gerçek + kaynak(dergi,yıl,DOI) + "vay be" puanı
[2] TASLAK (LLM, tek istekte)
    çıktı: başlık(<=100kr) + senaryo(45-60 kelime, kanca→gelişme→CTA) +
    vurgu kelimeleri[] + görsel promptları(2) + metadata(açıklama+etiketler)
[3] ONAY KUYRUĞU (senin mevcut sistemin)  ← insan onayı tek tık
[4] ÜRETİM: görseller (Civitai, 2 adet) + TTS + müzik
[5] RENDER: motor (aşağıda) → MP4
[6] QC (oto): süre 30-60sn, 2 stream, LUFS -12..-15, LRA>2 → geçenler onaya
[7] YAYIN: publish.py → unlisted (default) → sen public'e alırsın
[8] GÜNLÜK RAPOR: üretilen/reddedilen/yüklenen + nedenler
```

---

## 3) MİRA'YA TAŞINACAK MOTOR (bu workspace'te KANITLANMIŞ)

`bilgi-dozu/shorts/` altındaki paket, Rail-way'e taşınmaya hazır:
- `shorts_pipeline.py` — plates/timing/music/render aşamaları (Pillow + ffmpeg).
  Mira'da sadece: senaryo + timing.json + config + 2 görsel beslenir.
- `publish.py` — OAuth + SEO metadata + resumable yükleme + --simulate.
- `fonts/raw/` — Archivo Black + Inter (Türkçe glif test edilmiş halleri).
- `qc_check.py` — (yeni, ekte) otomatik kalite kapısı.
- ANA_PROMPT.md — LLM'in içerik üretim kuralları (Mira'nın sistem promptuna uyarlanır).

### Railway notları
- Dockerfile'a: `apt-get install -y ffmpeg python3-pil` (veya pip: pillow, numpy)
- requirements: pillow, numpy, google-api-python-client, google-auth-oauthlib
- Render worker ayrı servis (RAM izole) ya da aynı dyno'da çok dikkatli.
- ffmpeg binary'sini her deploy'da garanti kur (benim sandbox'ta her tur siliniyordu).

---

## 4) QC SCRIPT (qc_check.py) — her videoda otomatik koş

```python
#!/usr/bin/env python3
"""Kullanim: python3 qc_check.py video.mp4 [min_sure] [max_sure]
Cikti: PASS/FAIL + nedenler. CI/job icinde exit code: 0/1"""
import re, subprocess, sys

def main():
    path = sys.argv[1]
    lo, hi = float(sys.argv[2] if len(sys.argv) > 2 else 30), float(sys.argv[3] if len(sys.argv) > 3 else 60)
    fails = []
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    dur = float(p.stdout.strip() or 0)
    if not (lo <= dur <= hi): fails.append(f"süre {dur:.1f}s ({lo}-{hi} arası değil)")
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "stream=codec_type", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    kinds = sorted(p.stdout.strip().splitlines())
    if kinds != ["audio", "video"]: fails.append(f"stream eksik: {kinds}")
    # ses seviyesi + konuşma kanıtı
    p = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-map", "0:a",
                        "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"I:\s*(-?[0-9.]+) LUFS", p.stderr)
    lra = re.search(r"LRA:\s*(-?[0-9.]+) LU", p.stderr)
    lufs = float(m.group(1)) if m else -999
    lra_v = float(lra.group(1)) if lra else 0
    if lufs < -25: fails.append(f"SES YOK/çok düşük: {lufs} LUFS (sessiz-WAV bombası)")
    if lra_v < 2: fails.append(f"konuşma dinamiği yok: LRA {lra_v}")
    print("QC:", "PASS ✅" if not fails else "FAIL ❌ -> " + "; ".join(fails))
    print(f"  süre={dur:.1f}s  LUFS={lufs}  LRA={lra_v}")
    sys.exit(0 if not fails else 1)

if __name__ == "__main__":
    main()
```

---

## 5) İLK HAFTA YOL HARİTASI (önerim)
1. Mira'da ELLE 1 video: 3 görsel + TTS + render (mevcut kod) → qc_check'ten geçir
2. Patlarsa (muhtemelen render/sessiz-ses): motor paketini tak (bu workspace'ten)
3. 5 videoyu otomatik taslak→onay akışıyla üret, hepsi QC'yi geçsin
4. publish.py'ı OAuth'la bağla, unlisted test yükleme yap
5. Audit başvurusu + ilk public otomatik yayın
6. Sonra günlük 3-4'e ölçekle + günlük rapor botu
