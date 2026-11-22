# MC Bot Panel (Minecraft 1.8 - 26.3)

Çoklu Minecraft botlarını yönetmek ve test etmek için geliştirilmiş modern web kontrol paneli.

Resmi Mineflayer sürümü standart olarak yalnızca 26.1 sürümüne kadar destek sunarken, bu projede Mineflayer ve PrismarineJS ekosisteminin en son Minecraft **26.3** sürüm portları entegre edilmiştir.

## Özellikler

- **Geniş Sürüm Desteği:** Minecraft 1.8.x'ten en güncel **26.3** sürümüne kadar tam destek.
- **Web Kontrol Paneli:** Basit ve şık web arayüzü üzerinden tek tıkla botları başlatma ve durdurma.
- **Otomatik Reconnect & Chat:** Belirlenen aralıklarla hareket etme, sohbet mesajı gönderme ve bağlantı koptuğunda otomatik yeniden bağlanma.
- **Gerçek Zamanlı Loglar:** Socket.IO ile canlı log akışı ve durum takibi.

## Kurulum

1. Repoyu klonlayın:
   ```bash
   git clone https://github.com/lavelty/denemereporororo.git
   cd denemereporororo
   ```

2. Bağımlılıkları yükleyin:
   ```bash
   npm install
   ```
   *(Not: `postinstall` betiği, 26.3 protokol ve veri paketlerini otomatik olarak `minecraft-data` modülüne entegre edecektir).*

3. Paneli başlatın:
   ```bash
   npm start
   ```

4. Tarayıcınızda açın:
   `http://localhost:3000`

## Desteklenen Sürümler

- `auto` (Sunucu sürümünü otomatik algılar)
- `26.3`, `26.1`
- `1.21.x`, `1.20.x`, `1.19.x`, `1.18.x`, `1.16.5`, `1.12.2`, `1.8.8` ve aradaki tüm sürümler.
