# ESP32 cloud queue polling test

This sketch connects the ESP32 to the deployed Cloudflare Worker and polls the event queue. It prints event details to Serial Monitor but intentionally does not acknowledge events because audio playback is not implemented yet.

## Arduino IDE setup

1. Install the **ArduinoJson** library from Library Manager (Benoit Blanchon).
2. Open `esp32_cloud_poll_test.ino` and select **ESP32 Dev Module** (or the matching DevKit V1 board) and the correct COM port.
3. Replace the Wi-Fi placeholders and `DEVICE_API_KEY` locally in the sketch. Do not commit real Wi-Fi credentials or keys.
4. Upload, then open Serial Monitor at **115200 baud**.
5. Create a development event using the backend simulator. The ESP32 should print its ID, amount, simulation status, and spoken text.

The event stays pending until a later version successfully plays its audio and calls `acknowledgeEvent(eventId)`.

## TLS note

`secureClient.setInsecure()` is only for this development connectivity test. It encrypts the connection but does not authenticate Cloudflare's certificate. Replace it with certificate validation before using real payment events or credentials. The current backend simulator clearly marks all these test events as unverified simulations.
