# Mira Google Drive bağlantısı

Bu entegrasyon YouTube OAuth'undan ayrı tutulur. YouTube istemci bilgileri, `youtube` entegrasyon kaydı ve mevcut yayın akışı değiştirilmez.

## Google Cloud

1. Drive API'yi etkinleştir.
2. Google Auth Platform'da `Mira Drive` isimli **Web uygulaması** OAuth istemcisi oluştur.
3. Yetkili yönlendirme URI'si olarak `https://aimira.up.railway.app/api/drive/auth/callback` ekle.
4. OAuth izin ekranını tamamla. Uygulama test modundaysa, bağlanacak Google hesabını test kullanıcısı olarak ekle.

## Railway değişkenleri

Mira'nın production servisine, dağıtım yapılacağı zaman şu değişkenleri ekle:

- `DRIVE_CLIENT_ID`: yeni Mira Drive Web OAuth istemcisinin istemci kimliği
- `DRIVE_CLIENT_SECRET`: aynı istemcinin gizli anahtarı
- `DRIVE_FOLDER_ID`: Mira'nın okuyacağı Drive klasör kimliği (klasör URL'sindeki `/folders/...` kısmı)

Mevcut `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` ve YouTube tokenlarına dokunma.

## Yetkilendirme ve test

Dağıtımdan sonra Mira sitesine giriş yapmışken `/api/drive/auth` adresini aç ve Drive erişimini onayla. OAuth tokenı veritabanında `google_drive` anahtarıyla saklanır. Klasör dosyalarını kontrol etmek için `/api/drive/files` adresini aç.

İzin kapsamı `drive.readonly` olduğundan dosyalar okunabilir/indirilebilir; bu entegrasyon Drive'daki kaynak dosyaları silemez veya değiştiremez. Dosya indirme yardımcı fonksiyonu `downloadDriveFile` olarak sunulur.

**Bu değişiklikler kod hazırlığıdır. Kendiliğinden Railway dağıtımı veya Google hesabına erişim yapmaz.**
