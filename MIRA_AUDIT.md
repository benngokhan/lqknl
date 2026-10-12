# Mira — Sistem Denetimi ve Yol Haritası (10 Ekim 2026)

Bu belge, Mira kod tabanının gerçek testlerle denetlenmesinin sonucudur.
"Çalışıyor" olarak işaretlenen her satır bu oturumda birebir koşturulup doğrulanmıştır.

## 1. Test Sonuçları

| Bileşen | Durum | Kanıt |
|---|---|---|
| TypeScript derlemesi | ✅ Çalışıyor (1 hata düzeltildi) | `tsc --noEmit` temiz |
| Production build | ✅ Çalışıyor | `next build` başarılı |
| Edge TTS (Türkçe ses) | ✅ Çalışıyor | Canlı sentez: 22 kelime, 12.5 sn MP3 |
| Edge TTS kelime zaman damgaları | ✅ Çalışıyor | `getWordBoundaries()` → 100ns tick, doğrulandı |
| TTS JSON modu (ses+altyazı+süre) | ✅ Çalışıyor (yeni eklendi) | `/api/tts` `format:"json"` yanıtı test edildi |
| MP4 render (`/api/video/render`) | ✅ Çalışıyor (3 kritik hata düzeltildi) | 13.4s ve 18.4s MP4 üretimi, kare kare doğrulama |
| Altyazı gömme (Türkçe karakter) | ✅ Çalışıyor | 6s/10s karelerinde senkronlu, kalın, altta altyazı göründü |
| ElevenLabs bağlantısı | ⚠️ Test edilemedi | `ELEVENLABS_API_KEY`/`VOICE_ID` bu ortamda yok |
| Civitai görsel üretimi | ⚠️ Test edilemedi | `CIVITAI_API_KEY` bu ortamda yok |
| YouTube trend araştırması | ⚠️ Test edilemedi | `YOUTUBE_API_KEY` bu ortamda yok |
| LLM sağlayıcıları (OpenRouter/Groq/Gemini/Ollama) | ⚠️ Test edilemedi | API anahtarları bu ortamda yok |
| Veritabanı akışları (kuyruk, taslak, onay) | ⚠️ Test edilemedi | `DATABASE_URL` bu ortamda yok |
| Üretim motoru (mock mod, uçtan uca) | ✅ Çalışıyor (yeni eklendi) | `/api/automation/produce` → 18.4s MP4, ~8.5 sn üretim süresi |
| Render lib refactor regresyonu | ✅ Çalışıyor | Refactor sonrası `/api/video/render` 200 + doğru süre |

## 6. Üretim Motoru (10 Ekim 2026 akşamı eklendi)

- `src/lib/render-video.ts` — render çekirdeği route'tan bağımsız lib oldu; route artık ince sarmalayıcı.
- `src/lib/script-parse.ts` — worker taslağından SESLENDİRME vb. bölümleri çıkarır.
- `src/app/api/automation/produce/route.ts` — gerçek akış: taslak → LLM 3 görsel promptu → TTS+altyazı → Civitai 3 görsel → MP4 → `content_assets` + içerik `ready` olur. `mock:true` ile DB/Civitai/LLM'siz tam test destekler.
- `src/app/api/video/asset/[id]/route.ts` — üretilen videoyu Postgres'ten sunar (?content=ID ile en yeni video).
- Yeni DB tablosu: `content_assets` (Railway'de `npm run db:push` ile oluşturulmalı).
- Gerçek akış hâlâ kanıt bekliyor: Civitai ve LLM anahtarları ile canlı koşu yapılacak.

## 7. YouTube Upload Modülü (10 Ekim 2026 akşamı eklendi)

- `src/lib/youtube.ts` — bağımsız OAuth2 + resumable `videos.insert` (googleapis bağımlılığı yok). Token'lar `integrations` tablosunda.
- `GET /api/youtube/auth` → consent'e yönlendirir (state cookie korumalı); `GET /api/youtube/auth/callback` → code exchange + kanal kaydı + başarı sayfası.
- `GET /api/youtube/status` (?check=channel ile canlı kanal doğrulama, 1 kota birimi).
- `POST /api/youtube/upload` → `ready` içerik + video varlığı → yükleme → `content_items.published` + `publishedAt` + operations log. Cookie (UI butonu) veya x-mira-key (otomasyon) yetkili.
- Metadata: taslaktaki AÇIKLAMA/ETİKETLER kullanılır; categoryId=27 (Education, env ile değişir).
- Test edilenler: 401/502 guard yolları, consent redirect'i (scope: youtube.upload + youtube.readonly, access_type=offline, prompt=consent, state cookie eşleşmesi) ✅. Gerçek token exchange + upload, kullanıcının Google kurulumunu gerektirir → `docs/YOUTUBE_SETUP.md`.
- **Kota:** günde ~6 yükleme (10k birim, insert=1600). **Private kilidi:** unaudited uygulamada public yüklemeler private kilitlenir — varsayılan `YOUTUBE_DEFAULT_PRIVACY=private`.

## 2. Düzeltilen Hatalar

1. **`outfits/[id]` route tip hatasi** — `RouteContext` global tipi kullanılıyordu; `tsc` kırmızıydı ve Railway build'i bundan patlardı. Inline tip ile düzeltildi.
2. **`spawn /ROOT/node_modules/ffmpeg-static/ffmpeg ENOENT`** — Next.js bundler ffmpeg-static'in binary yolunu bozuyordu; video üretimi **hiç çalışamazdı** (Railway'de de). Çözüm: `next.config.ts` → `serverExternalPackages: ["ffmpeg-static", "@andresaya/edge-tts"]`.
3. **Sabit 20 saniye süre** — Ses 12.5s iken video 20s üretiyor, son 7.5s ölü sessizlikti. Artık `durationSeconds` parametresi, yoksa FFprobe mantığıyla (ffmpeg -i parse) gerçek ses süresinden ölçülüyor. Test: 1.8s/12.5s/18s talepler → 10.6s/13.4s/18.4s çıktı.
4. **Altyazı konumu** — libass `MarginV=180` PlayResY=288 birimindeydi; altyazı ekranın üst ortasında duruyordu. Stil düzeltildi (`FontSize=17, Bold=1, MarginV=34`) → altyazı artık altta ve kalın.
5. **Font bağımlılığı** — Railway imajında sistem fontu garantisi yok. DejaVu Sans (Regular+Bold) `public/fonts/` içine bundle edildi ve `fontsdir` ile refere edildi.
6. **TTS altyazıları yoktu** — Edge TTS kelime zamanları hiç kullanılmıyordu (altyazılar tahmini karakter oranına göre bölünüyordu → senkron kaçıyordu). Yeni `src/lib/narration.ts`: kelime boşluklarından (cümle sonu >300ms boşluk) gerçek senkron altyazı grupları üretiyor. Edge noktalama işaretlerini word-boundary'den temizlediği için cümle tespiti boşluk süresiyle yapılıyor — kalibre edildi.

## 3. Kalan Eksikler (öncelik sırasıyla)

| # | Eksik | Not |
|---|---|---|
| 1 | **Uçtan uca üretim motoru** | Taslak → narration → 3 görsel (Civitai) → render → asset'e kayıt tek akışta yok; parçalar var, birleştiren yok |
| 2 | **YouTube upload** | OAuth2 + `videos.insert` tamamen eksik. Kota: günde ~6 video (1600 birim/yükleme). **Dikkat:** audit'den geçmemiş Google projesinden yüklenen videolar private kilitlenir |
| 3 | **MP4 kalıcı depolama** | Railway diski ephemeral. MP4'ler Postgres'te (asset tablosu) veya S3/R2'de tutulmalı — onay arayüzü videoyu oradan göstermeli |
| 4 | **Onay → yayın zinciri** | Review sayfası videoyu oynatıp "Onayla" ile YouTube'a yüklemeli; şu an onay yalnızca durum değiştiriyor |
| 5 | **Zamanlayıcı** | Günlük araştırma+üretim için cron (Railway Cron veya cron-job.org'dan auth'lu GET) dokümante edilmeli |
| 6 | `.env.example` güncelliği | YOUTUBE_API_KEY, CIVITAI_API_KEY, ELEVENLABS_* eksikti — güncellendi |

## 4. Railway Notları

- `fontconfig` + DejaVu kaldırılmış imajlarda bile render çalışsın diye font bundle edildi.
- MP4/Railway ephemeral disk: üretilen videoyu içerik onayından önce kaybetmemek için kalıcı depolama şart.
- Cron: Railway "Cron Jobs" ile `/api/automation/research` (sabah) ve üretim worker'ı için zamanlanmış çağrılar planlanacak. Her cron çağrısı `x-mira-key: $MIRA_AUTOMATION_SECRET` header'ı ile gelmeli.

## 5. Test Scriptleri

Kökteki test scriptleri (bu oturumda kullanıldı):
- `scripts/test-tts.cjs` — canlı Edge TTS + kelime zamanları
- `scripts/test-render.cjs` — uçtan uca render (3 görsel + gerçek ses + altyazı)

Çalıştırmak için: önce `npm run dev`, sonra `node scripts/test-render.cjs`.

## 9. FFmpeg SIGKILL Çözümü — Segmentli Render (11 Ekim 2026)

**Semptom:** Railway'de "MP4 birleştirme hatası: (exit=null, signal=SIGKILL)", 3 denemenin hepsi ~1sn'de ölüyor.

**Teşhis zinciri:**
1. `libass … ASS_FEATURE_WRAP_UNICODE` mesajı yalnızca UYARI (zararsız).
2. `signal=SIGKILL` + ~1s = sistem seviyesinde öldürülme (RAM sınırı): tek pass'te 3×1080x1920 zoompan zinciri Railway container'ını aşıyordu.
3. Çözüm denemelerinde ikinci bulgu: Node'dan spawn edilen bu ffmpeg-static build'i MPEG-TS segment dosyalarını okurken **deterministik SIGSEGV** veriyor (bash'te sorunsuz). Bu yüzden .ts yerine .mp4 segment kullanıldı.

**Çözüm (test edildi):** 4 hafif çağrı: her görsel tek-başına .mp4 segment (düşük RAM) → concat demuxer + altyazı + ses tek geçişte. Produce mock ile uçtan uca: 15.85sn video, altyazı + sahne geçişleri kare kare doğrulandı; typecheck + build temiz.

## 10. Görsel sağlayıcı yedek zinciri (Tensor.Art → Gemini → Pollinations)

- Yaşanan hata: Tensor.Art `HTTP 400 invalid authorization header` (Railway'deki anahtarın yapıştırma biçimi bozuktu; 401 değil 400 = anahtar yanlış değil, header formatı yanlış).
- `src/lib/tensorart.ts`: `sanitizeCredential` ile tırnak, "Bearer " öneki, boşluk/satır sonu temizleniyor (temizleme sırası mock fetch testiyle doğrulandı).
- `src/lib/generate-image.ts` (yeni): üretim artık `generateImage(prompt)` üzerinden zincirleme: 1) Tensor.Art 2) Gemini 2.5 Flash Image (yalnızca `GEMINI_API_KEY` varsa; 9:16 `imageConfig`) 3) Pollinations (anahtarsız, 576x1024 flux). Tümü hata verirse tek birleşik hata mesajı döner; başarıda `provider` adı asset metadata'sına yazılır.
- Pollinations gerçekleri (canlı testlerle): `safe=true` parametresi artık 402 döndürüyor (premium'a taşınmış, kaldırıldı); anonim kademe hız aşımını **402/500** olarak yansıtıyor; bu yüzden sağlayıcı içi minimum 25sn çağrı aralığı + 402/429/5xx'te 45sn soğumayla en fazla 5 deneme var (402→402→200 senaryosu mock testle geçti).
- Dayanıklılık notu: Günde ~12-16 görsel için zincir fazlasıyla yeterli. Görsel patlaması (aynı video içinde 3 art arda üretim) için kalıcı çözüm = Railway'e ücretsiz `GEMINI_API_KEY` (AI Studio; ~500 görsel/gün) eklemek; Pollinations yalnızca son-kale yedeğidir.

## 11. Railway SIGKILL, 2. perde: son geçiş re-encode kaldırıldı (copy-merge)

- Belirti (canlı, 11 Ekim 21:48): %82 "MP4 birleştirme" aşamasında her denemede 5-7 saniyede `(exit=null, signal=SIGKILL)`; ayrıca bir koşuda sayfa yenilenip üretim ekranı kayboldu (konteyner OOM-killer Node/Next sürecini de vurdu). V1 segmentli pipeline segmentleri kodluyordu ama SON GEÇİŞ 3 segmenti concat + altyazı yakma ile **tüm videoyu 1080x1920'de baştan x264 encode** ediyordu — küçük konteynerde OOM asıl buradan geliyordu.
- Çözüm (V2, `render-video.ts`): altyazılar artık segment başına yakılıyor (`captionsForWindow` ile zaman penceresi kaydırılmış SRT; sınırı aşan altyazı iki segmentte de kırpılarak gösterilir); son geçiş `-c:v copy` ile saf mux (audio AAC encode yalnız). Video hiç çözülüp yeniden kodlanmıyor.
- Test (mock produce, route üstünden, 2x): edge-tts 14.4s + 8 caption + render ~8.0-8.4s (önceki 11.4s; final pass neredeyse bedava); çıktı h264 1080x1920 yuv420p 30fps + AAC; 2s ve 11s karelerinde segmente özel doğru altyazılar doğrulandı (Türkçe karakterler temiz).
- Beklenen canlı log: `[Mira MP4] render success (segmented, copy-merge)`.
- Yedek kaldıraç (segment bile SIGKILL yerse): 720x1280 düşük profil — şimdilik eklenmedi, gerekirse tek seferde eklenecek.

## 13. Railway SIGKILL, 3. perde: profil merdiveni + ffmpeg RSS probu

- Belirti (canlı, 22:29): V2 copy-merge deploy'lu hâlde segment aşaması ~1 saniyede `(exit=null, signal=SIGKILL)` gördü (stderr `Parsed_subtitles_4` = segmentteki altyazı filtresi; V2'nin çalıştığının kanıtı). Final re-encode gitmişti; segment+libass bile konteyneri tetikliyor.
- Çözüm (V3, `render-video.ts`):
  - **Profil merdiveni**: önce `hi` (1080x1920, ultrafast, crf23), kill-benzeri hata (SIGKILL/SIGSEGV/SIGABRT/ENOMEM/killed/zaman aşımı — `isRetryableKillError`) olursa otomatik `low` (720x1280, crf24, font size orantılı). MIRA_RENDER_PROFILE=hi|low ile zorlanabilir. Argüman/veri hatalarında (kod bugı) merdiven yürümez — doğru davranış.
  - **ffmpeg RSS probu**: çocuk sürecin /proc/<pid>/status VmRSS'i 250ms'de örneklenir; tepe değer hata mesajına ve `[Mira MP4] render success` loguna yazılır. Railway logları artık gerçek RAM rakamını gösterecek.
- Test (lokal): `isRetryableKillError` 5 senaryo geçti; low profil uçtan uca render **4.9s, tepe RSS 92MB**, 720x1280 + 3/3 segment altyazısı doğru (6s karesi "Kalabalıktan kaçarlar"); typecheck+build temiz. Merdivenin hi→low düşüş dalı lokalin belleği bol olduğu için canlı görünmedi; Railway logundaki `profil düşürüldü` satırı doğrulayacak.
- Sonraki kaldıraçlar (low da ölürse): libass yerine drawtext (fontconfig/libass yok), ya da Railway plan RAM artışı. RSS logları hangi kaldıracın gerekli olduğunu söyleyecek.

## 13b. Eş zamanlı ajanla birleşim: a33f389 → low profil içinde

- Aynı saatlerde başka bir oturum da SIGKILL'a `a33f389` (720x1280 sabit, 24fps, threads=1, zoompan'sız, crf25) push'ladı. Tek seferde 1080p/zoom kaybı verir ve ölçüm/yedek içermiyordu; yaklaşımının yük-azaltma kısmı V3 merdiveninin **low profiline** (720x1280@24, threads=1, crf25) entegre edildi; hi profili (1080x1920@30, zoompan) çalışan ortamlarda korunuyor. Conflict çözümü: render-video.ts V3'te kaldı.

## 14. İlk video üretildi (23:02) + üçüzlü rafine: süre/ses/filigran-log

- Dönüm noktası: hat uçtan uca çalıştı, 54sn video üretildi (22:59-23:02). Kalan şikayetler: pollinations.ai filigranı, sessiz video, 30sn üstü süre.
- **Süre**: `capNarrationForDuration` (script-parse.ts) — seslendirme metni cümle sınırında kırpılıyor (hedef 44, tavan 58 kelime; ölçülen hız ~1.8-2.2 kel/sn ≈ ≤27sn). `render-video`'da MIRA_MAX_VIDEO_SECONDS varsayılanı 30 (hard clamp; ses kırpmaz, TTS bütçesi zaten kısa tutar).
- **Sessizlik**: sandıkta edge-tts volume -19.2dB ile açıkça okunur (volumedetect), kalıp verisi orijinal checkpoint şüphesini güçlendirdi. produce'a ffmpeg volumedetect probu eklendi: taze TTS sessizse (mean < -45dB) hata → retryStage 3 kez tazeler; sessiz veya >34sn kalmış checkpoint'ler "bayat" sayılıp otomatik yeniden üretilir. stages.tts.meanVolumeDb loglanır → sonraki sessizlik iddiasında veriyle konuşacağız.
- **Filigran**: zincir hâlâ pollinations'a düşüyor → Tensor.Art VE Gemini patlıyor demektir. generate-image artık her sağlayıcı düşüşünü Railway loguna `[Görsel] <name> başarısız: <detay>` diye yazıyor — bir sonraki üretimde kök sebep görünecek (muhtemel: gemini-2.5-flash-image model adı/erişimi ya da Tensor.Art anahtarı hâlâ). Filigran ancak Gemini veya Tensor.Art çalışınca kalkar.
- Testler: capNarration 3 senaryo (kısa/uzun/devasa); mock produce 69 kelimelik metinle → video 30.0s, speech -19.4dB, captions doğru; typecheck+build temiz.

## 15. İlk mahsul analizi (01:50) → kısa metin + soyut görsel çözümleri

- Kullanıcının Drive üzerinden gönderdiği canlı ürün incelendi: 11.96sn, 720x1280@24 (low profil ✓), ses -20.1dB (SESLİ ✓). Altyazılar konuyu anlatıyor (TMSF banka garantisi); "anlamsız" hissi = soyut POLLINATIONS görselleri (yeşil ışık huzmesi vb.) + sadece ~12sn.
- Kök nedenler: (1) worker promptu 40-48 kelime ister ama model ~25 kelimeye düşmüş; tek deneme, taban doğrulaması yoktu. (2) Görsel LLM promptu "sahne bağlanan" yerine soyut atmosfere teşvik ediyordu; anlatı metni hiç verilmiyordu.
- **Çözüm 1 (worker)**: başlık doğrulamasından sonra SESLENDİRME kelime tabanı (<38) → aynı başlık yapısını koruyan TEK uzatma denemesi; kabul kuralı (başlıklar tam + ≥38 kelime + ret-değil). taslak metadata'sına narrationWords yazılır, Telegram bildirimi kelime sayısını gösterir.
- **Çözüm 2 (produce güvenlik ağı)**: narrationCap.words < 32 ise üretim anında "Kısa anlatı uzatma" stage'i (44-56 kelime hedefi, retryStage 3x, çıktı 30-90 kelime koridoru, ardından yine cap 44/58). ESKİ kısa taslaklar da böylece düzelir — taslak silmeye gerek yok. Başarısız olursa stages.script.expandSkipped'a sebep yazılır, kısa metinle devam eder.
- **Çözüm 3 (görsel kalitesi)**: imagePromptsWithLlm artık narrationText'i de alıyor; prompt şartı: anlatının o anıtlarını birebir tasvir eden SOMUT sahne (kişi/obje/yer), soyut ışık/gradyan/geometri YASAK. Amaç: yeşil lazer huzmesi → kasa kapısı/para/sayaç gibi konuya ait kareler.
- Filigran: hâlâ pollinations (kare1 sağ alt). Gemini/Tensor.Art sebep logları [Görsel] satırlarında bekleniyor (kullanıcıdan Railway logu istenecek).
- Test kanıtları: typecheck+build ✓. LLM-içeren yeni yollar (worker retry, üretim uzatma, yeni görsel prompt) lokalde test EDİLEMEDİ (sandbox'ta LLM API anahtarı yok) — Railway'deki ilk üretimle doğrulanacak; stages.script.expandedFromWords / narrationWords ve Railway loglarında "Kısa anlatı uzatma" satırı kanıt olacak.

## 16. Tam otonomi: xlsx plan bankası + işçi otopilotu + zincirleme kuyruk (01:30-02:2x kilidi)

- Kullanıcı repo'ya `Bilgi_Dozu_20_Short_Icerikleri.xlsx` yükledi (20 konu: başlık/kategori/hook/özet/hashtag). İmport mekanizması: `src/lib/content-plan.ts` parsePlanXlsx (kolonlar: Video Başlığı, Konu/Kategori, Hook, Senaryo Özeti, Hashtag'ler) + `POST /api/automation/import-xlsx-plan` — her satır mevcut `/api/automation/queue` sözleşmesine akıtılıyor (30g kopya koruması + görev kaydı uçtan uca korunur; sıfırdan logic yok). Panel butonu: "📋 20'lik planı kuyruğa al" (emerald) — sonuç buton etiketinde ("X eklendi · Y kopya").
- **Otopilot (worker)**: taslak kaydedilip eleme geçince MIRA_AUTO_PRODUCE!==0 ise: (1) review route üzerinden `approve_video` (review artık x-mira-key de kabul ediyor; onay operasyonu mevcut sözleşmeyle birebir aynı yazılır → produce kapısı "onaylı içerik" şartını doğal olarak görüyor), (2) produce fire-and-forget tetiklenir, (3) kuyrukta sıradaki içerik için worker kendini zincirler (MIRA_WORKER_CHAIN_MAX, varsayılan 6 derinlik; body.chainDepth ile). `autopilot` bilgisi route yanıtında.
- **Yayın kapısı YERİNDE KALIYOR**: otopilot videoyu üretir, panelde/Telegram'da hazır durur; YouTube'a "yayınla" basmak yine kullanıcıda. (Determined safety: YouTube upload ayrı gate.)
- Yerel kanıtlar: parsePlanXlsx gerçek dosyada 20/20 satır, 0 ihlal; typecheck+build ✓. Railway-only (lokal doğrulanamaz): review approve akışı DB ister, otopilot+zincir ilk gerçek turda doğrulanacak; `autopilot` yanıt alanı + operations logları ("autonomy") kanıt olacak.
