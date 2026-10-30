# QRIS Soundbox backend

## Deploy cloud tanpa laptop

Versi Cloudflare Workers + D1 sudah disiapkan supaya API bisa diakses ESP32 lewat HTTPS saat laptop mati. Ikuti [panduan deploy Cloudflare](cloudflare/README.md). Ini versi cloud terpisah dari server Node.js lokal di bawah. Jangan mengaktifkan webhook Midtrans sebelum metode GoPay Static QRIS disetujui.

Backend awal untuk development QRIS Soundbox. Backend dapat membuat pratinjau TTS cloud dari PowerShell dan otomatis menghasilkan ucapan untuk setiap pembayaran simulasi. Integrasi ESP32 dan MAX98357A I2S menyusul. Backend ini tidak membuat QRIS dan tidak menganggap pembayaran simulasi sebagai pembayaran nyata.

## Kebutuhan

- Windows 11 dengan Node.js 20.6 atau lebih baru.
- Tidak ada paket tambahan atau npm yang diperlukan. HTTP server, JSON, hash SHA-512, dan tes memakai modul bawaan Node.js.

Periksa instalasi:

```powershell
node --version
npm --version
```

## Jalankan di Windows PowerShell

Dari folder proyek ini:

```powershell
Copy-Item .env.example .env
```

Buka `.env`, lalu ubah `DEVICE_API_KEY` dan `SIMULATOR_API_KEY` menjadi nilai acak lokal. Untuk mengaktifkan TTS cloud, buat akun SonexLabs dan isi `SONEXLABS_API_KEY` pada `.env`. Paket gratisnya mencakup 10.000 karakter dan satu klon suara menurut dokumentasi penyedia. Simpan API key hanya di `.env` lokal; jangan kirim ke chat atau commit ke Git. `SONEXLABS_VOICE_ID` opsional untuk memilih klon suara; biarkan kosong untuk memakai suara bawaan. Pertahankan `MIDTRANS_WEBHOOK_ENABLED=false` selama persetujuan GoPay Static QRIS belum ada.

Mulai backend:

```powershell
node src/server.js
```

Server default mendengarkan pada `0.0.0.0:8787` agar ESP32 di jaringan Wi-Fi yang sama bisa menjangkaunya. Untuk pengembangan, gunakan alamat IPv4 komputer di jaringan lokal, misalnya `http://192.168.1.20:8787`. Izinkan Node.js di Windows Firewall hanya pada jaringan Private bila Windows memintanya. Jangan teruskan port backend ke internet.

Mode perubahan otomatis saat mengedit kode:

```powershell
node --watch src/server.js
```

## Tes

Jalankan semua tes otomatis:

```powershell
node --test
```

Tes memakai direktori sementara dan tidak mengirim data ke Midtrans.

## Alur simulasi untuk development

Dengan `SIMULATOR_ENABLED=true`, `NODE_ENV=development`, dan API key pada `.env`, buat event simulasi:

```powershell
$headers = @{ 'X-Simulator-Key' = 'ganti-dengan-SIMULATOR_API_KEY-di-env' }
$body = @{ amount = 15000; idempotencyKey = 'uji-001' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/dev/simulate-payment' -Headers $headers -ContentType 'application/json' -Body $body
```

**Simulasi bukan pembayaran nyata.** Respons dan event menandai `isSimulated: true`, `isVerifiedPayment: false`, `productionEligible: false`, serta `eventType: "payment_simulated"`. Teks suaranya juga menyebut “SIMULASI, BUKAN PEMBAYARAN NYATA”. Server mengembalikan 404 untuk endpoint simulasi jika `NODE_ENV=production` atau simulator dinonaktifkan.

Jika `SONEXLABS_API_KEY` terisi, setiap simulasi baru juga membuat MP3 di `data/speech/`. Respons JSON memuat `tts.status` dan `tts.audioUrl`. Duplikat tidak memanggil penyedia TTS lagi sehingga tidak memakai kuota tambahan. Setelah membuat simulasi, unduh dan putar MP3 seperti ini:

```powershell
$headers = @{ 'X-Simulator-Key' = 'isi-dengan-SIMULATOR_API_KEY-di-env' }
$body = @{ amount = 15000; idempotencyKey = [guid]::NewGuid().ToString() } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/dev/simulate-payment' -Headers $headers -ContentType 'application/json' -Body $body
$result.tts
Invoke-WebRequest -Uri "http://localhost:8787$($result.tts.audioUrl)" -Headers $headers -OutFile '.\data\simulation-payment.mp3'
Start-Process '.\data\simulation-payment.mp3'
```

Tiap simulasi baru yang berhasil memakai kuota gratis TTS berdasarkan jumlah karakter. Jika `tts.status` bernilai `not_configured`, isi API key dan mulai ulang server. Jika bernilai `failed` atau `not_generated`, periksa koneksi atau kuota TTS. Audio simulasi tidak menandakan pembayaran nyata.

## Coba TTS cloud Bahasa Indonesia dari PowerShell

Daftar di [SonexLabs](https://docs.sonexlabs.com/text-to-speech/indonesian), ambil API key, isi `SONEXLABS_API_KEY` di `.env`, lalu mulai ulang server. Request ini mengirim teks ke API cloud SonexLabs dan menyimpan hasil MP3 ke `data/tts-preview.mp3`:

```powershell
$headers = @{ 'X-Simulator-Key' = 'isi-dengan-SIMULATOR_API_KEY-di-env' }
$body = @{ text = 'Simulasi, bukan pembayaran nyata. Lima belas ribu rupiah diterima dalam simulasi.' } | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri 'http://localhost:8787/dev/tts-preview' -Headers $headers -ContentType 'application/json' -Body $body -OutFile '.\data\tts-preview.mp3'
Start-Process '.\data\tts-preview.mp3'
```

Endpoint pratinjau hanya tersedia saat `SIMULATOR_ENABLED=true` dan `NODE_ENV` bukan `production`, serta memerlukan `X-Simulator-Key`. Teks dibatasi 4096 karakter per permintaan. Paket gratis SonexLabs saat ini memberi 10.000 karakter; harga setelah batas tersebut tercantum pada [dokumentasi penyedia](https://docs.sonexlabs.com/pricing). Jangan tambahkan metode pembayaran jika ingin tetap tanpa billing. Berkas MP3 di folder `data/` diabaikan oleh Git.

## API untuk ESP32

Semua panggilan perangkat memakai header `X-Device-Key: <DEVICE_API_KEY>`.

| Method dan path | Fungsi |
| --- | --- |
| `GET /health` | Status server, mode, dan jumlah antrean. Tidak memuat rahasia. |
| `GET /api/events?limit=10` | Mengambil event belum diakui, paling banyak 50 per poll. |
| `POST /api/events/{id}/ack` | Mengakui event yang sudah diterima/ditangani ESP32. |
| `POST /dev/simulate-payment` | Membuat event non-produksi; butuh header `X-Simulator-Key` dengan `SIMULATOR_API_KEY`. |
| `GET /dev/simulate-payment/{id}/audio` | Mengunduh ucapan MP3 untuk event simulasi; butuh `X-Simulator-Key`. |
| `POST /webhooks/midtrans` | Endpoint integrasi terpisah, mati secara default. |

Event tetap muncul saat polling sampai ESP32 mengakui ID-nya. Pengiriman bersifat *at least once*: jika ESP32 kehilangan respons, ID yang sama dapat muncul lagi. Simpan ID yang sedang diproses pada perangkat agar event yang sama tidak diputar dua kali. Akui sesudah perangkat berhasil menangani event sesuai kebijakan perangkat.

Contoh poll dan acknowledgment dari PowerShell:

```powershell
$deviceHeaders = @{ 'X-Device-Key' = 'ganti-dengan-DEVICE_API_KEY-di-env' }
$queue = Invoke-RestMethod -Uri 'http://localhost:8787/api/events?limit=10' -Headers $deviceHeaders
$queue.events

# Setelah event telah ditangani oleh ESP32:
$eventId = $queue.events[0].id
Invoke-RestMethod -Method Post -Uri "http://localhost:8787/api/events/$eventId/ack" -Headers $deviceHeaders
```

Interval yang disarankan untuk poll kosong adalah sekitar 2 detik (`pollAfterMs` dari respons). Bila menguji dari komputer ke ESP32, ganti `localhost` dengan IPv4 komputer.

## Penyimpanan dan deduplikasi

Antrean dan indeks idempotensi disimpan sebagai jurnal append-only di `data/events.jsonl` secara lokal, di luar kontrol versi. Setiap event dan ack disimpan sebagai baris JSON terpisah dan diserialkan dalam proses yang sama. Baris terakhir yang terpotong saat proses berhenti dapat dipulihkan saat startup. Simulasi dideduplikasi berdasarkan `idempotencyKey`; bila key tidak dikirim, setiap permintaan menjadi event baru. Webhook Midtrans dideduplikasi berdasarkan `order_id`, jadi notifikasi berulang untuk order yang sama tidak membuat pembayaran kedua.

Backend versi awal ini ditujukan untuk satu proses Node.js di satu komputer lokal. Jangan jalankan beberapa salinan dengan `DATA_FILE` yang sama. Data belum dibersihkan otomatis karena catatan deduplikasi harus tetap ada agar notifikasi lama tidak membuat event ulang.

## Midtrans: nonaktif sampai metode disetujui

`MIDTRANS_WEBHOOK_ENABLED` default-nya `false`; endpoint mengembalikan `503 webhook_disabled`. Tidak ada kredensial live di repository. Setelah GoPay Static QRIS disetujui dan nilai `payment_type` resmi diketahui, siapkan `.env` secara lokal:

```text
MIDTRANS_WEBHOOK_ENABLED=true
MIDTRANS_SERVER_KEY=<server key yang diberikan Midtrans, simpan lokal>
MIDTRANS_ALLOWED_PAYMENT_TYPE=<nilai payment_type yang telah dikonfirmasi>
```

Server menolak startup jika webhook diaktifkan tanpa kedua konfigurasi itu. Integrasi memverifikasi `signature_key` SHA-512 Midtrans sebelum membuat event, hanya menerima metode pembayaran yang dikonfigurasi, dan hanya mengantrekan status `settlement` atau `capture` yang tidak berstatus fraud selain `accept`. Notifikasi harus datang melalui HTTPS publik saat benar-benar dipakai; server development ini HTTP lokal dan bukan deployment webhook publik.

Untuk setup Midtrans, format signature dan status pembayaran mengikuti [dokumentasi notifikasi resmi Midtrans](https://docs.midtrans.com/docs/https-notification-webhooks). Jangan mengaktifkan endpoint ini atau memasukkan server key sebelum persetujuan dan konfigurasi merchant tersedia.

## Variabel lingkungan

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Alamat bind server; `0.0.0.0` untuk akses dari ESP32 di LAN. |
| `PORT` | `8787` | Port HTTP backend. |
| `NODE_ENV` | `development` | Simulator otomatis ditutup saat `production`. |
| `DATA_FILE` | `./data/events.jsonl` | Jurnal event dan deduplikasi lokal. |
| `DEVICE_API_KEY` | wajib | Kunci akses API poll dan ack. |
| `SIMULATOR_ENABLED` | `false` | Harus `true` untuk endpoint development. |
| `SIMULATOR_API_KEY` | wajib saat simulator aktif | Kunci khusus endpoint simulasi. |
| `SONEXLABS_API_KEY` | kosong | Opsional; diperlukan untuk pratinjau TTS cloud. Simpan hanya di `.env` dan jangan commit. |
| `SONEXLABS_VOICE_ID` | kosong | Opsional; ID suara SonexLabs yang digunakan untuk pratinjau dan simulasi TTS. |
| `MIDTRANS_WEBHOOK_ENABLED` | `false` | Harus tetap mati sampai GoPay Static QRIS disetujui. |
| `MIDTRANS_SERVER_KEY` | kosong | Simpan hanya secara lokal setelah tersedia. |
| `MIDTRANS_ALLOWED_PAYMENT_TYPE` | kosong | Nilai harus dikonfirmasi sebelum webhook diaktifkan. |
