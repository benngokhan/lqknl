# KartaL kişisel asistanı

Bu sürüm mevcut panelin ve yayın işlerinin yanına eklenir; veri tabanı göçü, silme veya yayın tetikleme yapmaz. `/v2` sayfasındaki **KartaL** sekmesinde yazılı sohbet ve kullanıcı dokununca çalışan tarayıcı mikrofonu bulunur. Eski paneldeki sesli pencerede de aynı yardımcı kullanılır. Tarayıcı/platform desteği ve mikrofon izni gerekir.

## Yetenek ve sınırlar

- Genel sohbet: panelde kayıtlı OpenRouter anahtarı veya sunucu ortamındaki OpenRouter anahtarıyla `openrouter/free`; daha sonra anahtarsız Pollinations yedeği. Groq/Gemini ancak sunucu sahibi `KARTAL_ALLOW_BILLABLE_FALLBACK=true` ile açıkça açarsa kullanılır. Bu sağlayıcılar çevrimiçi, harici ve kotalıdır; Groq/Gemini hesabının faturalandırma ayarlarını servis sahibi kontrol etmelidir. OpenRouter'da yalnız `openrouter/free` veya somut bir `:free` model kabul edilir ve sıfır fiyat sınırı uygulanır. Anahtarsız yedeğe veritabanındaki kalıcı anılar gönderilmez. Sağlayıcılar kullanılamazsa başarısızlık açıkça bildirilir.
- Vikipedi araması: ör. `İnternette kara delik araştır`. Bu tam web araştırması değildir; bağlantılı özetleri gösterir.
- `İşçilerin durumunu kontrol et`: iki GitHub deposunun son workflow kayıtlarını salt okunur listeler. Drive/YouTube veya bütün işçi hattını kontrol ya da onarım anlamına gelmez.
- `Drive dosyalarını göster`: panelde tanımlı **tek** Drive klasörünün ilk en fazla 1000 öğesi, alt klasörler olmadan listelenir. Panelin Drive bağlantısı ve klasör ayarı gerekir.
- `görev ekle: süt al` mevcut görev tablosuna bir satır ekler. Bu tek başına bildirim/alarma dönüşmez. Kayıt sonucu belirsiz olursa tekrarlamadan önce görev listesi kontrol edilmelidir.
- Riskli işlemler, cihaz kontrolü, video üretimi ve dış yayın bu sohbetten çalıştırılmaz. Eski tablet kuyruğu ayrı ve kapalı bir bölümde korunur; bağlantısı doğrulanmamıştır.
- Sohbet geçmişi yalnızca açık sayfanın belleğindedir; mevcut kayıtlar silinmez. Tarayıcı/sağlayıcı kullanımıyla mesajlar dış sağlayıcıya gidebilir; şifre, anahtar ve özel veriler paylaşılmamalıdır.
- Otomatik Arena mesajı, saat 10 alarmı veya gizli arka plan dinlemesi eklenmez.

## Güvenlik ve test

API ayrı doğrulanmış `mira_entry` oturumu ve aynı kökenli JSON POST ister. Model tarafından araç çalıştırılmaz, giriş ve geçmiş sınırlandırılır. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` çalıştırılmalıdır. Gerçek cihazda mikrofon, canlı oturum ve kurulu model anahtarları bu kaynak kodundan garanti edilemez. Eski agent durum endpoint'i GET olsa da görev durumlarını değiştirebildiği için yalnızca eski kuyruk açıldığında çağrılır.
