# Deploy QRIS Soundbox to Cloudflare Workers + D1

This is a cloud-hosted version of the Node backend. It uses Cloudflare D1 for the event queue, acknowledgements, and persistent deduplication. The ESP32 can reach the HTTPS Worker URL while the laptop is off.

## 1. Create the free Cloudflare account and D1 database

1. Sign in at [Cloudflare](https://dash.cloudflare.com/) and open Workers & Pages.
2. Install Node.js 20+ on the computer used for setup. From the project folder, run:

   ```powershell
   npm install
   npx wrangler login
   npx wrangler d1 create soundbox-qris
   ```

3. Copy the `database_id` returned by the last command into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
4. Create the table:

   ```powershell
   npx wrangler d1 migrations apply soundbox-qris --remote
   ```

## 2. Add secrets and deploy

Make two long, random keys (one for ESP32, one for the development simulator). Never reuse or publish the values. Set them without placing secrets in the repository:

```powershell
npx wrangler secret put DEVICE_API_KEY
npx wrangler secret put SIMULATOR_API_KEY
```

For cloud TTS, enter the SonexLabs key only in this prompt (optional):

```powershell
npx wrangler secret put SONEXLABS_API_KEY
npx wrangler secret put SONEXLABS_VOICE_ID
```

`SONEXLABS_VOICE_ID` may be left unset if the provider default is desired. Midtrans stays disabled. Do not set Midtrans secrets until GoPay Static QRIS has been approved and its payment type confirmed.

Deploy:

```powershell
npx wrangler deploy
```

The command prints a URL like `https://soundbox-qris-backend.<account>.workers.dev`. Use that base URL for the ESP32 backend setting; do not include `:8787`.

## 3. Smoke-test the deployment

```powershell
$base = 'https://soundbox-qris-backend.<account>.workers.dev'
Invoke-RestMethod -Uri "$base/health"

$simHeaders = @{ 'X-Simulator-Key' = 'PASTE_THE_SIMULATOR_KEY_YOU_SET' }
$body = @{ amount = 15000; idempotencyKey = [guid]::NewGuid().ToString() } | ConvertTo-Json
$created = Invoke-RestMethod -Method Post -Uri "$base/dev/simulate-payment" -Headers $simHeaders -ContentType 'application/json' -Body $body
$created.warning
$created.event.spokenText
$created.tts

$deviceHeaders = @{ 'X-Device-Key' = 'PASTE_THE_DEVICE_KEY_YOU_SET' }
$queue = Invoke-RestMethod -Uri "$base/api/events?limit=10" -Headers $deviceHeaders
$queue.events
```

The simulator is always marked `isSimulated: true`, `isVerifiedPayment: false`, and `productionEligible: false`. It is strictly for development and is not proof of payment. Midtrans webhook is disabled by default.

If TTS is configured and the response says `ready`, fetch the MP3 (the simulator header is required):

```powershell
Invoke-WebRequest -Uri "$base$($created.tts.audioUrl)" -Headers $simHeaders -OutFile '.\simulation-payment.mp3'
Start-Process '.\simulation-payment.mp3'
```

## Local test and development

```powershell
npm test
npx wrangler dev
```

For local D1, create the local schema first:

```powershell
npx wrangler d1 migrations apply soundbox-qris --local
```

## Free tier and limits

Cloudflare Workers Free has a daily request allowance and D1 has separate included read/write/storage limits. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) before production use. Do not treat a development free plan as guaranteed availability for a payment product.
