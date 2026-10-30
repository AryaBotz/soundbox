# ESP32 cloud queue polling test

This sketch connects the ESP32 to the deployed Cloudflare Worker, polls the event queue, downloads the generated MP3, plays it through MAX98357A, and acknowledges the event after playback finishes.

## Arduino IDE setup

1. Install **ArduinoJson** (Benoit Blanchon) and **ESP32-audioI2S** (Wolle) from Library Manager.
2. Open `esp32_cloud_poll_test.ino` and select **ESP32 Dev Module** (or the matching DevKit V1 board) and the correct COM port.
3. Enter your Wi-Fi credentials and `DEVICE_API_KEY` directly in the sketch on your computer. Do not commit actual credentials to GitHub.
4. Upload, then open Serial Monitor at **115200 baud**.
5. Create a development event using the backend simulator. The ESP32 should print its ID and play the audio through the MAX98357A.

`SIMULATOR_API_KEY` is for the development simulator on the computer only; it does not belong on the ESP32.

The event stays pending until MP3 playback finishes and the ESP32 receives a successful acknowledgment response. Device audio uses HTTP Basic authentication mapped to the device key; it does not use the simulator key.

Default I2S pins in the sketch: GPIO 26 BCLK, GPIO 25 LRC/WS, and GPIO 22 DIN. These must match your physical wiring.

## TLS note

`secureClient.setInsecure()` is only for this development connectivity test. It encrypts the connection but does not authenticate Cloudflare's certificate. Replace it with certificate validation before using real payment events or credentials. The current backend simulator clearly marks all these test events as unverified simulations.
