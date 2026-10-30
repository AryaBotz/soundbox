# ESP32 cloud queue polling test

This sketch connects the ESP32 to the deployed Cloudflare Worker and polls the event queue. It prints event details to Serial Monitor but intentionally does not acknowledge events because audio playback is not implemented yet.

## Arduino IDE setup

1. Install the **ArduinoJson** library from Library Manager (Benoit Blanchon).
2. Open `esp32_cloud_poll_test.ino` and select **ESP32 Dev Module** (or the matching DevKit V1 board) and the correct COM port.
3. Fill in `secrets.h` beside the sketch with Wi-Fi credentials and `DEVICE_API_KEY`. The tracked `secrets.example.h` is a template; `secrets.h` is ignored by Git. Do not commit real Wi-Fi credentials or keys.
4. Upload, then open Serial Monitor at **115200 baud**.
5. Create a development event using the backend simulator. The ESP32 should print its ID, amount, simulation status, and spoken text.

`SIMULATOR_API_KEY` is for the development simulator on the computer only; it does not belong on the ESP32.

The event stays pending until a later version successfully plays its audio and calls `acknowledgeEvent(eventId)`.

## TLS note

`secureClient.setInsecure()` is only for this development connectivity test. It encrypts the connection but does not authenticate Cloudflare's certificate. Replace it with certificate validation before using real payment events or credentials. The current backend simulator clearly marks all these test events as unverified simulations.
