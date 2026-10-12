# SİNYAL DÖNGÜSÜ — Kanal verisiyle yön bulma (Mira entegrasyonu)

## Döngü (haftalık, 10 dakika)
```
[Pazar akşamı] channel_pulse.py çalıştır (3-5 kota birimi)
      ↓
pulse_report.json + content_directive.md oluşur
      ↓
MIRA_SIGNAL_PUSH_URL + MIRA_AUTOMATION_SECRET ayarlıysa
/api/automation/signal adresine güvenli POST yapılır
      ↓
Mira'nın taslak işçisi son kayıtlı direktifi okur
      ↓
(1 hafta sonra) tekrar nabız → direktif güncellenir
```

## Hangi metrik neyi söyler (Shorts'a özel)
| Metrik | Nereden | Anlamı | Aksiyon |
|---|---|---|---|
| Görüntülenme hızı (ilk 48 saat) | pulse (views/day) | Algoritma itiyor mu | >2×medyan = format klonla |
| **Ortalama izlenme % (avg view %)** | YouTube Studio → Short detay | Kaydırma/bırakma oranı — EN ÖNEMLİ | <%70 ise kanca sorun; %>85 ise format sağlam |
| Etkileşim % ((beğeni+yorum)/görüntülenme) | pulse otomatik | İçerik derinliği | <%0.8 ise CTA/soru ekle |
| Abone dönüşümü | Studio → analiz | Marka gücü | Yüksekteyse seri artır |
| Yorum içeriği | elle | Talep haritası ("uzay da getir") | Sonraki serinin konusu |

**Not:** "Ortalama izlenme %" API'den alınabilir ama OAuth + yt-analytics.readonly
scope ister (sadece bu tek metrik için değecekse söyle, eklerim). pulse şimdilik
Data API anahtarıyla (kolay) çalışır; izlenme %'sini haftada 1 elle Studio'dan
bakıp direktife işlemen 30 saniye sürer.

## Kurulum
1. Google Cloud'da (publish için açtığın proje) → API anahtarı al
   (Credentials → Create Credentials → API key; YouTube Data API v3 zaten açık)
2. `python3 channel_pulse.py --handle @kankanal --key AIza... --config shorts_config.json`
3. Çıkan `content_directive.md`'deki JSON bloğunu Mira'ya ver.
   Örnek sistem prompt eki:
   ```
   SİNYAL DİREKTİFİ (haftalık güncellenir):
   {content_directive.md içindeki JSON}
   KURAL: agirlik_artir kümelerinden en az %60 taslak üret;
   azalt_durdur kümelerinden taslak üretme; klonlanacak_videolar listesindeki
   videoların kanca yapısını (ilk cümle kalıbını) yeni konulara uyarla.
   ```

## Karar kuralları (motorun mantığı)
- Küme medyanı ≥ 1.5× kanal medyanı → 🟢 AĞIRLIK ARTIR
- Küme medyanı ≤ 0.5× kanal medyanı → 🔴 DUR
- Tek video medyanın 2 katını aşarsa → 🚀 AYKIRI DEĞER: kancasını klonla
- 3 hafta üst üste zayıf kümeye düşen format → format değişikliği (yeni görsel stil/hız)

## Örnek (şu anki kanalın görüntüsünden okuma)
- "Kapı etkisi" 1.1B ve "uyku yıkanması" 965 → **günlük hayat paradoksu + vücut bilim**
  kümeleri şu an en güçlü sinyal → yeni taslakların çoğu bu iki kümeden seçilmeli.
- "Beynin kararı senden önce biliyor" (2) ve "zaman yoğunlaşır" (2) → soyut/kavramsal
  kancalar şu an zayıf → somut, gündelik, deney anlatan kancalara dön.


## Mira'ya otomatik aktarım

GitHub'a kod gönderildiğinde tek başına haftalık sinyal üretimi başlamaz. Nabız betiği çalıştırılırken şu ortam değişkenlerini tanımla:

- `MIRA_SIGNAL_PUSH_URL`: Mira'nın canlı temel adresi (sonuna `/api/automation/signal` eklenmez; betik ekler).
- `MIRA_AUTOMATION_SECRET` (veya `MIRA_N8N_SECRET`): Mira API'siyle aynı gizli anahtar.
- YouTube Data API v3 anahtarı betiğe `--key` ile verilir.

Örnek:

```bash
export MIRA_SIGNAL_PUSH_URL="https://CANLI-MIRA-ADRESIN"
export MIRA_AUTOMATION_SECRET="MIRA_ILE_AYNI_GIZLI_ANAHTAR"
python3 channel_pulse.py --handle "@GERCEK_KANAL_HANDLE" --key "$YOUTUBE_DATA_API_KEY"
```

Başarılı aktarımda `/api/automation/signal` direktifi veritabanındaki `operations` kaydına yazar. Taslak işçisi son başarılı direktifi okur. Aktarım ayarlı değilse dosyalar oluşturulur ama canlı Mira güncellenmez; bu durumda JSON bloğu elle aktarılabilir.

## Ölçüm sınırları

- Betik şu anda görüntülenme sayısından **yayından beri ortalama günlük hızı** hesaplar; ilk 48 saatin tarihsel görüntülenme hızını geriye dönük çıkaramaz. Bunun için günlük snapshot tutulması gerekir.
- Ortalama izlenme yüzdesi, abone dönüşümü ve yorum metinleri mevcut Data API çağrısından gelmez; bunlar Studio/YouTube Analytics üzerinden ayrıca alınmalıdır.
- Gerçek kanal handle'ı ve canlı Mira adresi doğrulanmadan örnek değerleri kullanma.
