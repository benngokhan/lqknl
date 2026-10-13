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

## AÇIK TEST KÜMESİ — HAYVAN, TARİH VE LİSTİCLE
- Hayvan konuları (ahtapot dahil) ve tarih anekdotları **yasak değildir**; işçiler bunları yeni konu adayı olarak üretebilir.
- "3 şaşırtıcı gerçek" gibi listicle biçimleri de **yasak değildir**; tek-gerçek formatıyla birlikte test edilebilir.
- Önceki düşük görüntülenme örnekleri tek başına kalıcı dışlama gerekçesi sayılmaz. Kullanıcının belirttiği 30–40 beğeni sinyali de dikkate alınır; performans yalnızca konu adına göre değil, görüntülenme, beğeni, izlenme süresi/tutma oranı ve örnek sayısı birlikte değerlendirilerek ölçülür.
- Haftalık sinyal direktifi (ağırlık_artır/azalt_durdur) varsa uygulanır; yeni adaylar yine kaynak doğrulaması ve kalite kontrolünden geçer.

## BAŞLIK FORMÜLÜ (kanıtlı, zayıf başlıkların hepsi bundan çıkmıştı)
2. tekil şahıs ("Sen / Beynin") + somut eylem/nesne + sürpriz fiil + "!" + tek emoji (🧠/🤯). 3. şahıs/soyut başlık = otomatik düşük puan.

## DOĞRULAMA KOŞULU (akademik kapı)
- Seçilen konunun iddia tek net cümleye indirgenebilir olmalı ve akademik motorlarda (Crossref/OpenAlex/PubMed) ispatlayıcı kaynağı gündeme gelebilmeli; kaynak bulunmayan "halk bilinirliği" reddedilir.
- Mit/efsane/pop-psikoloji şartları (burç, arınma şovu) giremez; "dopamin detoksu" gibi adı efsaneleşmiş başlıklar ancak gerçeği patlatan bilim çerçevesiyle girer.

## NOT — İşçinin seçim mimarisi
Research rotası Google Trends listesini BESLEME olarak alır, trend değildir; uygun küme+güçlü kanca bulunamazsa "daha az öğe üret" asla uydurma eklemez (sinyal direktif korunarak).
