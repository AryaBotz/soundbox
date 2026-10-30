#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "secrets.h"

const char* EVENTS_URL = "https://soundbox-qris-backend.aryahakim678.workers.dev/api/events?limit=10";
const char* ACK_URL_PREFIX = "https://soundbox-qris-backend.aryahakim678.workers.dev/api/events/";
const unsigned long POLL_INTERVAL_MS = 2000;

WiFiClientSecure secureClient;
String lastPrintedEventId;
unsigned long lastPollAt = 0;

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");

  const unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 30000) {
    delay(500);
    Serial.print('.');
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi connected");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWi-Fi connection failed. Check the 2.4 GHz SSID and password.");
  }
}

void pollEvents() {
  HTTPClient http;
  http.setTimeout(15000);
  http.begin(secureClient, EVENTS_URL);
  http.addHeader("X-Device-Key", DEVICE_API_KEY);

  const int status = http.GET();
  Serial.printf("Queue HTTP status: %d\n", status);
  if (status != HTTP_CODE_OK) {
    if (status > 0) Serial.println(http.getString());
    else Serial.println("Request failed. Check Wi-Fi and Cloudflare URL.");
    http.end();
    return;
  }

  DynamicJsonDocument document(8192);
  const DeserializationError error = deserializeJson(document, http.getStream());
  http.end();
  if (error) {
    Serial.printf("Could not parse queue JSON: %s\n", error.c_str());
    return;
  }

  JsonArray events = document["events"].as<JsonArray>();
  if (events.isNull() || events.size() == 0) {
    Serial.println("Queue empty.");
    lastPrintedEventId = "";
    return;
  }

  for (JsonObject event : events) {
    const char* eventId = event["id"] | "";
    if (!eventId[0] || lastPrintedEventId == eventId) continue;
    lastPrintedEventId = eventId;

    Serial.println("--- EVENT: SIMULATION / DEVELOPMENT ---");
    Serial.printf("ID: %s\n", eventId);
    Serial.printf("Simulated: %s\n", (event["isSimulated"] | false) ? "YES" : "NO");
    Serial.printf("Verified payment: %s\n", (event["isVerifiedPayment"] | false) ? "YES" : "NO");
    Serial.printf("Amount (IDR): %ld\n", (long)(event["amount"] | 0));
    Serial.printf("Speech text: %s\n", event["spokenText"] | "");
    Serial.println("Not acknowledging yet; audio playback is not implemented in this test sketch.");
  }
}

// Panggil hanya setelah perangkat benar-benar selesai menangani event,
// misalnya setelah audio berhasil diputar. Jangan panggil saat tes polling ini.
bool acknowledgeEvent(const String& eventId) {
  if (WiFi.status() != WL_CONNECTED || eventId.length() != 36) return false;

  HTTPClient http;
  http.setTimeout(15000);
  const String url = String(ACK_URL_PREFIX) + eventId + "/ack";
  http.begin(secureClient, url);
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  const int status = http.POST("");
  const String response = status > 0 ? http.getString() : "";
  http.end();
  Serial.printf("Ack HTTP status: %d; %s\n", status, response.c_str());
  return status == HTTP_CODE_OK;
}

void setup() {
  Serial.begin(115200);
  delay(500);

  // Development-only TLS mode: encrypts traffic but does not verify the server certificate.
  // Replace with certificate validation before using real payment events or credentials.
  secureClient.setInsecure();

  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) pollEvents();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    delay(500);
    return;
  }

  if (millis() - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = millis();
    pollEvents();
  }
  delay(20);
}
