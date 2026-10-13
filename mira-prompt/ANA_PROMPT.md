# BİLGİ DOZU — ANA ÜRETİM PROMPTU (kopyala-yapıştır)

Aşağıdaki metni, yeni video serisi istediğin her mesajın başına yapıştır.
Sondaki "SERİ TALİMATI" bölümüne sadece o turun istediğini yaz. Tasarım, font, renk, logo konumu ve altyazı stili her üretimde aynı kalır.

---

BİLGİ DOZU Shorts üretimi — ANA PROMPT (her seride aynen uygula):

MARKA & FORMAT
- Marka: BİLGİ DOZU. Dikey 9:16; üretim profili 720x1280, 24 fps (zaman aşımı riskini azaltmak için); hedef ~35 sn (35-40 sn bandı). Referans şablonun yerleşimi ve grafik paketi değişmez.
- Kategori: konu başına DOĞRULANABİLİR, klişe olmayan, "vay be" dedirten tek gerçek
  (az bilinen + kaynaklı). Her seride farklı 5 konu; önceki serilerde kullanılanları tekrar etme.
- YASAK: hayvan konuları (ahtapot dahil), tarih anekdotları, "3 şaşırtıcı gerçek" listicle,
  genel AI/gelecek spekülasyonu ve daha önce kullanılan konular (kapı etkisi, uyku beyin temizliği,
  hipnik jerk, refleks, dopamin detoksu).
- Her video: 1 kanca + 2-3 destekleyici cümle + pekiştirme + CTA
  ("Daha fazla bilgi dozu için takip etmeyi unutma!").

GÖRSEL
- Konuya birebir uyan tam 2 adet koyu/sinematik dikey arka plan (AI görsel), sahne geçişi ortada. Görsellerin içinde yazı, logo veya watermark olmayacak; grafik paketi yalnızca sabit render motoru ekler.
- Plato: soğuk tonlama + vignette + grain + üst/alt siyah gradient.
- Grafik paket (hepsinde birebir aynı):
  • Üstte ince ilerleme çubuğu (gri zemin, aktif kısım neon yeşil #D4FF3F, glow'lu)
  • Sol üst "BİLGİ DOZU" neon etiket
  • Archivo Black büyük başlık (2-3 satır, taşma yok — otomatik font küçültme),
    son ifade neon yeşil vurgulu, satır animasyonlu giriş
  • Alt-ortada kelime-kelime SENKRON altyazı: aktif kelime SARI (255,225,74),
    vurgu kelimeleri kalıcı sarı, diğerleri beyaz/gri
  • Küçük gri kaynak notu (gerçek + dergi/yıl) + "BİLGİ DOZU" marka imzası
- Fontlar: Archivo Black (başlık/altyazı) + Inter (not). Türkçe gliflerde
  Layout.BASIC motoru ZORUNLU (raqm Türkçe birleşik glifleri bozuyor).

SES (MONTAJLI — videoya GÖMÜLÜ gelir)
- Tek doğal/otoriter TR ses (bu sohbette voice-00 kayıtlı).
- Pipeline: VO üret → duraklamaları sıkılaştır (x0.72) → kelime zamanlaması çıkar →
  minimal gerilim beat (55Hz drone + pulse + CTA riser) → VO'da sidechain ducking →
  -14 LUFS / TP -1.5 master → MP4'ün ses kanalına GÖM.
- KRİTİK KONTROL (daha önce yaşanan hata): yazılan her WAV'ta int16 ölçekleme
  (x32767) OLMALI; teslim öncesi her videoda ses kanalı -70 LUFS'a yakın SESSİZ OLMAMALI,
  LRA > 2 olmalı (konuşma var kanıtı). Teslimde 1 adet 4 sn'lik kanıt MP3 de üret.
- Teslim öncesi her videoda: Duration ~35 sn, video+audio 2 stream, LUFS -12..-15 kontrolü.

TESLİM PAKETİ (her seri için)
- Tüm videolar TEK ZIP: <seri_adi>.zip (workspace sınırı ~128MB — videolar CRF 23 ile
  sıkıştırılır, ara dosyalar silinir; ZIP kökünde her video kendi klasöründe: <id>/video.mp4)
- ZIP KÖK DİZİNİNE YouTube otomatik yükleme kiti EKSİKSİZ dahil edilir:
  publish.py (çalışır halde), shorts_config.json (tüm videoların verileri),
  README_PUBLISH.md, BASLA.txt + her video klasörüne script.txt ve timing.json.
  (client_secrets.json ve token.json KULLANICININ KİMLİK DOSYALARIDIR: kullanıcı daha
  önce yüklediyse kopyala; yüklemediyse kiti "kendi client_secrets.json'unu buraya koy"
  notuyla hazırla — asla uydurma kimlik dosyası üretme.)
- ZIP yanında SOHBETTE tablo halinde YAYIN METADATA'sı (elle yükleyecekler için):
  her video için Başlık (<=100 kr, "🧠 #Shorts" dahil) / Açıklama (kanca + 💡 gerçek +
  📚 kaynak + 📌 CTA + 5 hashtag) / 10-15 etiket listesi.
- Teslim öncesi QC: her videodan 2 kare (baş+son) tek sheet'te göster.

OPERASYONEL KURALLAR (kredi/hız optimizasyonu)
- Her tur başında: imageio-ffmpeg yeniden kurulup ffmpeg_path.txt güncellenir
  (sandbox binary'leri turlar arası siliniyor).
- Render'ları 2'li gruplar halinde yap (RAM 1.9GB — veryfast preset + threads 2).
- Ara dosyaları (plate, mix, vo, bg, qc) teslim sonrası sil; videolar + ZIP kalsın.
- Kullanıcı "aldım" demeden eski ZIP'leri silme.
- Görsel üretim limiti tur başına 10 — 5 video x 2 sahne tam sınır; başarısız olursa
  sahne2'yi sahne1'den türet (flip+crop).

SERİ TALİMATI:
[BURAYA O TURUN İSTEĞİ: ör. "5 video daha, kategori: uzay" ya da konu listesi]
