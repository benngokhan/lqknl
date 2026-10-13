# BİLGİ DOZU — SABİT VİDEO ŞABLONU
Bu dosya, Mira'nın senaryo işçisinin okuduğu tek sabit görsel şablon sözleşmesidir. Tasarım her videoda aynıdır; yalnızca konuya bağlı iki arka plan görseli, başlık metni, anlatım/altyazı kelimeleri ve kaynak notu değişebilir.

## Değiştirilemez yerleşim
- Dikey video; Railway zaman aşımı riskini azaltmak için üretim profili **720×1280, 24 FPS**. Bu çözünürlük, referansın küçültülmüş çıktısıdır; tasarımın kendisi değişmez.
- Üst kenarda ince ilerleme çubuğu: koyu gri iz, ilerleyen neon yeşil **#D4FF3F** bölüm ve hafif glow.
- Sol üstte yuvarlatılmış neon yeşil etiket içinde **BİLGİ DOZU**.
- Sol üst/üst-orta bölgede büyük Archivo Black başlık: 2–3 satır, beyaz metin, son vurgu bölümü neon yeşil. Satır giriş animasyonu ve taşmayı önleyen otomatik font küçültme.
- Alt-orta bölgede anlatımla kelime kelime senkron altyazı. Aktif kelime sarı **RGB(255,225,74)**; diğer kelimeler beyaz/gri; seçilen vurgu kelimeleri geçtikten sonra da sarı kalır.
- Alt bölümde küçük, gri kaynak notu (iddia + gerçek kaynak/yıl) ve en altta ortalı **BİLGİ DOZU** imzası.
- Fontlar ve hizalama, motorun sabit Archivo/Inter düzeninden gelir. Türkçe glifler için Pillow **Layout.BASIC** kullanılmalı.
- Arka planlara metin/logo/watermark çizdirilmez; marka grafikleri yalnızca render motoru çizer.
- Hafif koyu/soğuk color grade, vignette, film grain ve üst-alt karartma korunur. Kamera hareketi çok hafif olur; şablon öğeleri yer değiştirmez.

## Sahne kuralı
- Tam olarak **2** konuya doğrudan bağlı, dikey, sinematik arka plan.
- Sahne 1 kancayı/açılış durumunu gösterir. Sahne 2 ana bilgiyi, mekanizmayı veya sonucu gösterir.
- Geçiş yaklaşık videonun ortasında olur. Aynı sahne bütün video boyunca kalmamalı.
- Soyut ışık huzmeleri veya rastgele teknoloji görselleri, anlatılan gerçek için somut karşılık oluşturmuyorsa kullanılmaz.
- Görsellerin kendisinde yazı, marka etiketi, filigran veya üretici logosu bulunmamalıdır.

## Süre ve ses
- Hedef süre **35–40 saniye**; 70–80 kelimelik doğal Türkçe anlatım ve sabit CTA: “Daha fazla bilgi dozu için takip etmeyi unutma!”
- Kelime zamanlaması gerçek ses dosyasından çıkarılır. Altyazı, anlatımla senkron olmalıdır.
- Ses ve düşük seviyeli gerilim müziği videoya gömülür. QC hedefi yaklaşık −14 LUFS; sessiz/eksik sesli çıktı reddedilir.

## Kesin yasak
- Başka bir görsel şablon, farklı yerleşim, yeni renk paleti, farklı logo yeri veya rastgele altyazı stili üretme.
- İki sahneden fazla görsel kullanma.
- Görsel sağlayıcı başarısız olunca filigranlı Pollinations gibi yasaklı yedeğe düşme.
- Sabit şablon motoru başarısızsa farklı renderer ile alakasız video üretme; hata ver ve üretimi durdur.
