# YouTube yayın kiti — güvenli kullanım

1. `shorts_config.example.json` dosyasını `shorts_config.json` adıyla kopyala.
2. Her video için aynı kimliğe sahip klasör oluştur (ör. `s00_ornek/`).
3. Klasöre `script.txt`, `timing.json`, `bg1.png`, `bg2.png` ve `vo_raw.wav` dosyalarını koy.
4. `client_secrets.json` dosyasını Google Cloud OAuth istemci ayarlarından kendin edin; `mira-prompt/` içine yerel olarak koy.
5. Önce simülasyon yap: `python3 publish.py s00_ornek --simulate`.
6. Gerçek yüklemeden önce videoyu kalite kontrolünden geçir: `python3 qc_check.py s00_ornek/video.mp4 30 60`.
7. Gerçek yükleme varsayılan olarak liste dışı olur: `python3 publish.py s00_ornek --privacy unlisted`.

## Güvenlik

- `client_secrets.json`, `token.json`, API anahtarları ve erişim token'larını GitHub'a yükleme.
- İlk OAuth yetkilendirmesi yerel tarayıcı gerektirir; bu script, tarayıcı yetkilendirmesi olmayan sunucu ortamında tek başına ilk kurulumu tamamlayamaz.
- `--simulate` YouTube'a yükleme yapmaz.
- `shorts_config.json` örnek içerikle kalırsa yayınlama; başlık ve kaynak alanlarını gerçek videoya göre düzenle.
