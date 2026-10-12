# MİRA × BİLGİ DOZU MOTOR — KURULUM

Amaç: Mira'nın ürettiği her video, kanaldaki şablonla PİKSEL PİKSEL aynı olsun.
Yol: Tasarımı Mira'ya söyletmek yerine, bu motoru çalıştırmak.

## PAKET İÇİ
```
shorts_pipeline.py        → render motoru (plates/timing/music/render) — ŞABLON BURADA
publish.py                → YouTube yükleme (OAuth, SEO, --simulate)
qc_check.py               → otomatik kalite kapısı (PASS/FAIL + exit code)
MIRA_SYSTEM_PROMPT.txt    → Mira'nın LLM'ine sistem promptu (içerik sözleşmesi)
mira_content_schema.json  → LLM çıktı şeması + dolu örnek
MIRA_STYLE_SPEC.json      → tasarım sabitleri (referans doküman)
font/raw/                → Archivo Black + Inter + Anton (test edilmiş)
```

## MİRA İÇİNDE AKIŞ (taslak ONAYLANDIKTAN sonra)
```
1) LLM çıktısından:
   shorts/<video_id>/script.txt  yaz
   shorts_config.json'a "video_id" bloğunu ekle
2) Görselleri üret (Civitai) → shorts/<video_id>/bg1.png, bg2.png
3) TTS'i motorla üret → shorts/<video_id>/vo_raw.wav
   (Mira Edge-TTS kullanacaksa da vo_raw.wav yeterli; motor gerisini yapar)
4) cd shorts && python3 shorts_pipeline.py all <video_id>
5) python3 qc_check.py <video_id>/video.mp4 30 60      # FAIL ise işi reddet
6) python3 publish.py <video_id> --privacy unlisted    # veya --simulate
```

## requirements.txt
```
pillow
numpy
imageio-ffmpeg        # sandbox/konteynerde ffmpeg yoksa binary sağlar
google-api-python-client
google-auth
google-auth-oauthlib
```

## Dockerfile (Railway)
```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python3", "mira_server.py"]
```

## KRİTİK NOTLAR (3 canlı bomba)
1. RAM: 1080x1920 render için veryfast preset + threads 2 AYARLI GELİYOR;
   512MB dyno'da render'ı ayrı worker service'te koş.
2. Türkçe glifler: font çağrılarında Layout.BASIC'i KALDIRMAYA çalışma.
3. Ses: qc_check'i atlamayın; sessiz-WAV bug'ı "başarılı render" görünüyor.

## LLM SÖZLEŞMESİ ÖZETİ
Mira'nın LLM'i YALNIZCA şunları üretir: video_id, seo_title, title_lines,
note1, note2, accents, script, visual_prompt_1/2, description, tags.
→ ayrıntı: MIRA_SYSTEM_PROMPT.txt + mira_content_schema.json
Tasarım kararları (font/renk/koordinat/müzik/master) MOTORDA SABİT.
