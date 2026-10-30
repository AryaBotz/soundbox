#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Audio.h>

const char* WIFI_SSID = "ISI_NAMA_WIFI_2_4_GHZ";
const char* WIFI_PASSWORD = "ISI_PASSWORD_WIFI";
const char* DEVICE_API_KEY = "ISI_DEVICE_API_KEY";

const char* EVENTS_URL = "https://soundbox-qris-backend.aryahakim678.workers.dev/api/events?limit=10";
const char* ACK_URL_PREFIX = "https://soundbox-qris-backend.aryahakim678.workers.dev/api/events/";
const unsigned long POLL_INTERVAL_MS = 2000;
const uint8_t I2S_BCLK = 26;
const uint8_t I2S_LRC = 25;
const uint8_t I2S_DOUT = 22;
const uint8_t AUDIO_VOLUME = 12;

WiFiClientSecure secureClient;
Audio audio;
String currentEventId;
String lastStartedEventId;
bool audioFinished = false;
unsigned long lastPollAt = 0;
unsigned long lastAckAttemptAt = 0;

void audio_eof_mp3(const char* info) {
  Serial.printf("MP3 finished: %s\n", info);
  audioFinished = true;
}

void audio_info(const char* info) {
  Serial.printf("Audio: %s\n", info);
}

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

void pollEvents() {
  if (audio.isRunning() || currentEventId.length() > 0) return;

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
    lastStartedEventId = "";
    return;
  }

  for (JsonObject event : events) {
    const char* eventId = event["id"] | "";
    if (!eventId[0] || lastStartedEventId == eventId) continue;

    const bool isSimulated = event["isSimulated"] | false;
    const bool isVerified = event["isVerifiedPayment"] | false;
    if (!isSimulated && !isVerified) {
      Serial.println("Skipped event: it is neither a simulation nor a verified payment.");
      continue;
    }

    Serial.println("--- EVENT: SIMULATION / DEVELOPMENT ---");
    Serial.printf("ID: %s\n", eventId);
    Serial.printf("Simulated: %s\n", isSimulated ? "YES" : "NO");
    Serial.printf("Verified payment: %s\n", isVerified ? "YES" : "NO");
    Serial.printf("Amount (IDR): %ld\n", (long)(event["amount"] | 0));
    Serial.printf("Speech text: %s\n", event["spokenText"] | "");

    currentEventId = eventId;
    lastStartedEventId = currentEventId;
    const String audioUrl = String("https://soundbox-qris-backend.aryahakim678.workers.dev/api/events/") + currentEventId + "/audio";
    Serial.println("Downloading TTS audio and playing through MAX98357A...");
    if (!audio.connecttohost(audioUrl.c_str(), "device", DEVICE_API_KEY)) {
      Serial.println("Could not start MP3 playback. Event stays pending; check TTS status and speaker wiring.");
      currentEventId = "";
      lastStartedEventId = "";
    }
    return;
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  // Development-only TLS mode: encrypts traffic but does not verify the server certificate.
  // Replace with certificate validation before using real payment events or credentials.
  secureClient.setInsecure();

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(AUDIO_VOLUME);
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) pollEvents();
}

void loop() {
  audio.loop();

  if (audioFinished && currentEventId.length() > 0 && millis() - lastAckAttemptAt >= 2000) {
    lastAckAttemptAt = millis();
    if (acknowledgeEvent(currentEventId)) {
      Serial.println("Audio played; event acknowledged.");
      currentEventId = "";
      audioFinished = false;
      lastAckAttemptAt = 0;
    }
  }

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
