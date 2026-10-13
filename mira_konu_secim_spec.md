# BİLGİ DOZU — KONU SEÇİM SİGORTASI (worker spec) v1.1 — 13 Ekim 2026
*Kanal verisi: konu_arsivi.md (gerçek izlenme tablosu). Kod kullanımı: src/app/api/automation/research/route.ts prompt satırı AŞAĞIDAKİ tanımlarla senkron tutulur; haftalık sinyal direktifi (ağırlık_artır/azalt_durdur) bu listeyi GEÇERSİZ KILABİLİR — direktif gelmişse direktif kazanır.*

## ÇİFT ÖNCELİK (kanıtlı kanal kümeleri, mevcut 1K+ performans)

### 1. Uyku & beyin temizliği 🥇
- Kıstas: Uyku fizyolojisi, glymphatic sistem, rüya mekaniği, gece beyin işleri — ölçülmüş/teyitli.
- Kanca kalıbı: "Sen uyurken ___" / "Hiç uyumadan kaç —"
- Örnek: "Sen Uyurken Beynin Yıkanıyor" (1.2K ✓)

### 2. Beyin & nöroloji paradoksları 🥇
- Kıstas: Beynin kendisiyle çelişen, doğrulanabilir tek olay (beyin ağrıyı hissetmez; kör nokta; kapıdan geçince unutma).
- Kanca kalıbı: "Beynin sana ___" / "Gözünde kör nokta var ama ___"
- Örnek: "Beyniniz Ağrıyı Hissedemez" (1.1K ✓)

### 3. Günlük hayat paradoksları 🥇
- Kıstas: Sıradan günlük eylemin/olayın duyulmamış bilimsel açıklaması; izleyicinin yaşamına dokunan ölçülebilir ayağı olmalı.
- Örnek: "Odaya Niçin Girdiğinizi Kapı Siliyor" (1.1K ✓)

### 4. Dopamin & davranış ekonomisi 🥇
- Kıstas: scroll/ekran/bildirim davranışının mekaniği — değişken ödül döngüsü, beklenti dopamini; güncel yıla göre ispatlanabilir kullanım sayıları.
- Örnek: "Günde Kaç Saat Kaydırıyorsun" (1.1K ✓)

### 5. Uzay & astronomi ölçekleri 🥇
- Kıstas: Tek sayı/ölçek çarpıcısı ya da rekor (Venüs'te bir gün bir yıldan uzun; Mars'ta mavi gün batımı). Matematiksel ölçek olmadan "uzayda güzel şeyler" YOK.
- Örnek: "Venüs'te Bir Gün Bir Yıldan Uzun" (1.2K ✓)

### 6. Vücut & biyoloji paradoksları ⚪
- Kıstas: Somut bedensel tek-olay bilgisi (ikinci beyin; mide asidi metal eritir; kemik betondan güçlü). Pop-sağlık ("günde 2 litre su şart") değil, anatomik paradoks.
- Örnek: "İkinci Beyniniz Karnınızda" (352 → bir konu daha, sonra ölç)

## SINIRLI KÜME (az aday, sert süzgeç)

### 7. Fizik / coğrafya rekorları
- Tek net ölçü + tek zaman çizelgesi (en derin nokta, en hızlı rüzgâr, boyu rekor kıran ağaç). Derlemeden tek rekor çıkar.

### 8. Teknolojik ilkler
- Doğrulanabilir İLK belge/patent kaydının hikâyesi (ilk e-posta, ilk faks idi çıkış...). "İlk X" diye başlamayan teknoloji haberi bu kümeye girmez.

## KESİN KONU YASAKLARI
- Hayvan konuları (ahtapot dahil), tarih anekdotları ve "3 şaşırtıcı gerçek" listicle biçimi YASAKTIR.
- Genel AI/gelecek spekülasyonu, kanıtsız teknoloji tahmini ve birbirinden bağımsız gerçekler listesi YASAKTIR.
- Kullanıcının açıkça yasakladığı veya önceki serilerde kullandığı konuyu yeniden üretme. Kapı etkisi, uyku beyin temizliği, hipnik jerk, refleks ve dopamin detoksu daha önce kullanılmıştır; bunları yeni aday olarak seçme.
- Haftalık sinyal direktifi yalnızca izinli konu kümeleri arasında öncelik belirler; kesin yasakları geçersiz kılamaz.

## KONU SEÇİM DAVRANIŞI
- Öncelik kümeleri: uyku/beyin, nöroloji paradoksları, günlük hayat paradoksları, dopamin/davranış ve uzay ölçekleri.
- Kaynak doğrulaması ve tek ana gerçek kuralı her koşulda geçerlidir; uygun aday yoksa daha az öğe üret, yasaklı kategoriyle kotayı doldurma.

## BAŞLIK FORMÜLÜ (kanıtlı, zayıf başlıkların hepsi bundan çıkmıştı)
2. tekil şahıs ("Sen / Beynin") + somut eylem/nesne + sürpriz fiil + "!" + tek emoji (🧠/🤯). 3. şahıs/soyut başlık = otomatik düşük puan.

## DOĞRULAMA KOŞULU (akademik kapı)
- Seçilen konunun iddia tek net cümleye indirgenebilir olmalı ve akademik motorlarda (Crossref/OpenAlex/PubMed) ispatlayıcı kaynağı gündeme gelebilmeli; kaynak bulunmayan "halk bilinirliği" reddedilir.
- Mit/efsane/pop-psikoloji şartları (burç, arınma şovu) giremez; "dopamin detoksu" gibi adı efsaneleşmiş başlıklar ancak gerçeği patlatan bilim çerçevesiyle girer.

## NOT — İşçinin seçim mimarisi
Research rotası Google Trends listesini BESLEME olarak alır, trend değildir; uygun küme+güçlü kanca bulunamazsa "daha az öğe üret" asla uydurma eklemez (sinyal direktif korunarak).
