const SPEECH_URL = 'https://api.sonexlabs.com/v1/speech';

export function createSonexSpeech({ apiKey, voiceId = '', fetchImpl = fetch }) {
  return async function synthesize(text) {
    if (!apiKey) {
      const error = new Error('Cloud TTS is not configured. Set SONEXLABS_API_KEY in the local .env file.');
      error.statusCode = 503;
      throw error;
    }

    let result;
    try {
      result = await fetchImpl(SPEECH_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          text,
          output_format: 'mp3',
          ...(voiceId ? { voice_id: voiceId } : {})
        }),
        signal: AbortSignal.timeout(60_000)
      });
    } catch {
      const error = new Error('Could not reach the cloud TTS service. Check the internet connection and try again.');
      error.statusCode = 502;
      throw error;
    }

    if (!result.ok) {
      // Avoid exposing provider error bodies or account details to callers.
      const error = new Error(`Cloud TTS request failed (HTTP ${result.status}). Check the API key or free quota.`);
      error.statusCode = result.status === 429 ? 429 : 502;
      throw error;
    }
    if (result.headers?.get('x-voice-fallback') === 'true') {
      const error = new Error('SonexLabs did not recognize SONEXLABS_VOICE_ID and used its default voice instead. Check the voice ID in the SonexLabs dashboard.');
      error.statusCode = 422;
      throw error;
    }
    return Buffer.from(await result.arrayBuffer());
  };
}
