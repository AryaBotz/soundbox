import { rupiahToIndonesianWords } from '../src/indonesian-number.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const UUID = /^[0-9a-f-]{36}$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function keyMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env, header, setting) {
  return keyMatches(request.headers.get(header) ?? '', env[setting] ?? '');
}

function deviceBasicAuth(request, env) {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match || !env.DEVICE_API_KEY) return false;
  try {
    return keyMatches(atob(match[1]), `device:${env.DEVICE_API_KEY}`);
  } catch {
    return false;
  }
}

async function readBody(request) {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return { error: 'Content-Type must be application/json', status: 415 };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 16 * 1024) return { error: 'Request body too large', status: 413 };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return { body };
  } catch {
    return { error: 'Body must contain valid JSON object', status: 400 };
  }
}

function eventFromRow(row) {
  return { ...JSON.parse(row.event_json), id: row.id, dedupeKey: row.dedupe_key, acknowledgedAt: row.acknowledged_at };
}

async function enqueue(db, event, dedupeKey) {
  const id = crypto.randomUUID();
  const stored = { ...event, id, dedupeKey, acknowledgedAt: null };
  const result = await db.prepare('INSERT OR IGNORE INTO events (id, dedupe_key, event_json) VALUES (?, ?, ?)')
    .bind(id, dedupeKey, JSON.stringify(event)).run();
  if (result.meta.changes) return { duplicate: false, event: stored };
  const row = await db.prepare('SELECT id, dedupe_key, event_json, acknowledged_at FROM events WHERE dedupe_key = ?').bind(dedupeKey).first();
  return { duplicate: true, event: row ? eventFromRow(row) : null };
}

async function signatureValid(payload, serverKey) {
  const { order_id, status_code, gross_amount, signature_key } = payload;
  if (![order_id, status_code, gross_amount, signature_key].every((v) => typeof v === 'string' && v.length)) return false;
  const digest = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(`${order_id}${status_code}${gross_amount}${serverKey}`));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return keyMatches(signature_key.toLowerCase(), expected);
}

async function synthesize(text, env) {
  if (!env.SONEXLABS_API_KEY) return null;
  let response;
  try {
    response = await fetch('https://api.sonexlabs.com/v1/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.SONEXLABS_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, output_format: 'mp3', ...(env.SONEXLABS_VOICE_ID ? { voice_id: env.SONEXLABS_VOICE_ID } : {}) })
    });
  } catch {
    throw new Error('tts_unavailable');
  }
  if (!response.ok) throw new Error(response.status === 429 ? 'tts_quota' : 'tts_unavailable');
  if (response.headers.get('x-voice-fallback') === 'true') throw new Error('tts_voice_invalid');
  return new Uint8Array(await response.arrayBuffer());
}

async function makeAudioResponse(db, id) {
  const row = await db.prepare('SELECT audio FROM events WHERE id = ?').bind(id).first();
  if (!row?.audio) return json({ error: 'audio_not_ready', message: 'Audio tidak tersedia. Periksa konfigurasi TTS.' }, 404);
  return new Response(row.audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export async function onRequest(request, env) {
  const url = new URL(request.url);
  const db = env.DB;
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      const stats = await db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END) AS pending FROM events').first();
      return json({ status: 'ok', mode: 'cloudflare', simulatorEnabled: env.SIMULATOR_ENABLED === 'true', midtransWebhookEnabled: env.MIDTRANS_WEBHOOK_ENABLED === 'true', queue: { pending: stats.pending ?? 0, total: stats.total ?? 0 } });
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      if (!authorized(request, env, 'x-device-key', 'DEVICE_API_KEY')) return json({ error: 'unauthorized' }, 401);
      const raw = Number(url.searchParams.get('limit') ?? 10);
      const limit = Number.isInteger(raw) ? Math.min(50, Math.max(1, raw)) : 10;
      const { results } = await db.prepare('SELECT id, dedupe_key, event_json, acknowledged_at FROM events WHERE acknowledged_at IS NULL ORDER BY created_at LIMIT ?').bind(limit).all();
      return json({ events: results.map(eventFromRow), pollAfterMs: 2000, notice: 'Events may repeat until acknowledged. Deduplicate on the ESP32 by event id.' });
    }
    const deviceAudio = request.method === 'GET' && url.pathname.match(/^\/api\/events\/([0-9a-f-]{36})\/audio$/i);
    if (deviceAudio) {
      if (!deviceBasicAuth(request, env)) return json({ error: 'unauthorized' }, 401);
      const row = await db.prepare('SELECT event_json, audio FROM events WHERE id = ?').bind(deviceAudio[1]).first();
      if (!row || !JSON.parse(row.event_json).isSimulated) return json({ error: 'simulated_event_not_found' }, 404);
      if (!row.audio) return json({ error: 'audio_not_ready', message: 'TTS audio is not available for this event.' }, 404);
      return new Response(row.audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
    const ack = request.method === 'POST' && url.pathname.match(/^\/api\/events\/([^/]+)\/ack$/);
    if (ack) {
      if (!authorized(request, env, 'x-device-key', 'DEVICE_API_KEY')) return json({ error: 'unauthorized' }, 401);
      if (!UUID.test(ack[1])) return json({ error: 'event_not_found' }, 404);
      const row = await db.prepare('SELECT acknowledged_at FROM events WHERE id = ?').bind(ack[1]).first();
      if (!row) return json({ error: 'event_not_found' }, 404);
      const alreadyAcknowledged = row.acknowledged_at !== null;
      if (!alreadyAcknowledged) await db.prepare('UPDATE events SET acknowledged_at = ? WHERE id = ?').bind(new Date().toISOString(), ack[1]).run();
      return json({ eventId: ack[1], acknowledged: true, alreadyAcknowledged });
    }
    if (request.method === 'POST' && url.pathname === '/dev/simulate-payment') {
      if (env.SIMULATOR_ENABLED !== 'true') return json({ error: 'not_found' }, 404);
      if (!authorized(request, env, 'x-simulator-key', 'SIMULATOR_API_KEY')) return json({ error: 'unauthorized' }, 401);
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: 'request_error', message: parsed.error }, parsed.status);
      const { amount, idempotencyKey } = parsed.body;
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000_000) return json({ error: 'invalid_request', message: 'amount must be an integer rupiah amount from 1 to 100000000' }, 400);
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 120)) return json({ error: 'invalid_request', message: 'idempotencyKey must be a string from 1 to 120 characters' }, 400);
      const event = { provider: 'simulation', eventType: 'payment_simulated', source: 'development_simulator', verificationStatus: 'simulated_unverified', isVerifiedPayment: false, isSimulated: true, productionEligible: false, paymentReference: idempotencyKey ?? `sim-${crypto.randomUUID()}`, paymentMethod: 'simulated_qris', amount, currency: 'IDR', receivedAt: new Date().toISOString(), spokenText: `SIMULASI, BUKAN PEMBAYARAN NYATA. ${rupiahToIndonesianWords(amount)} diterima dalam simulasi.` };
      const result = await enqueue(db, event, `simulation:${event.paymentReference}`);
      let ttsStatus = env.SONEXLABS_API_KEY ? 'not_generated' : 'not_configured';
      if (!result.duplicate && env.SONEXLABS_API_KEY) {
        try {
          const audio = await synthesize(result.event.spokenText, env);
          await db.prepare('UPDATE events SET audio = ? WHERE id = ?').bind(audio, result.event.id).run();
          ttsStatus = 'ready';
        } catch { ttsStatus = 'failed'; }
      } else if (result.duplicate && result.event) {
        const row = await db.prepare('SELECT audio FROM events WHERE id = ?').bind(result.event.id).first();
        if (row?.audio) ttsStatus = 'ready';
      }
      return json({ warning: 'SIMULATION ONLY — NOT A REAL OR VERIFIED PAYMENT', duplicate: result.duplicate, tts: { status: ttsStatus, audioUrl: `/dev/simulate-payment/${result.event.id}/audio` }, event: result.event }, result.duplicate ? 200 : 201);
    }
    const audioMatch = request.method === 'GET' && url.pathname.match(/^\/dev\/simulate-payment\/([0-9a-f-]{36})\/audio$/i);
    if (audioMatch) {
      if (env.SIMULATOR_ENABLED !== 'true') return json({ error: 'not_found' }, 404);
      if (!authorized(request, env, 'x-simulator-key', 'SIMULATOR_API_KEY')) return json({ error: 'unauthorized' }, 401);
      const row = await db.prepare('SELECT event_json FROM events WHERE id = ?').bind(audioMatch[1]).first();
      if (!row || !JSON.parse(row.event_json).isSimulated) return json({ error: 'simulated_event_not_found' }, 404);
      return makeAudioResponse(db, audioMatch[1]);
    }
    if (request.method === 'POST' && url.pathname === '/dev/tts-preview') {
      if (env.SIMULATOR_ENABLED !== 'true') return json({ error: 'not_found' }, 404);
      if (!authorized(request, env, 'x-simulator-key', 'SIMULATOR_API_KEY')) return json({ error: 'unauthorized' }, 401);
      if (!env.SONEXLABS_API_KEY) return json({ error: 'tts_not_configured' }, 503);
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: 'request_error', message: parsed.error }, parsed.status);
      if (typeof parsed.body.text !== 'string' || !parsed.body.text.trim() || parsed.body.text.length > 4096) return json({ error: 'invalid_request' }, 400);
      const audio = await synthesize(parsed.body.text.trim(), env);
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
    }
    if (request.method === 'POST' && url.pathname === '/webhooks/midtrans') {
      if (env.MIDTRANS_WEBHOOK_ENABLED !== 'true') return json({ error: 'webhook_disabled' }, 503);
      if (!env.MIDTRANS_SERVER_KEY || !env.MIDTRANS_ALLOWED_PAYMENT_TYPE) return json({ error: 'webhook_not_configured' }, 503);
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: 'request_error', message: parsed.error }, parsed.status);
      const p = parsed.body;
      if (!await signatureValid(p, env.MIDTRANS_SERVER_KEY)) return json({ error: 'invalid_midtrans_signature' }, 401);
      if (p.payment_type !== env.MIDTRANS_ALLOWED_PAYMENT_TYPE || (p.currency && p.currency !== 'IDR') || !['settlement', 'capture'].includes(p.transaction_status) || (p.fraud_status !== undefined && p.fraud_status !== 'accept')) return json({ received: true, enqueued: false, reason: 'not_an_approved_successful_payment' });
      const amount = Number(p.gross_amount);
      if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'invalid_gross_amount' }, 400);
      const event = { provider: 'midtrans', eventType: 'payment_confirmed', source: 'midtrans_webhook', verificationStatus: 'provider_signature_verified', isVerifiedPayment: true, isSimulated: false, productionEligible: true, paymentReference: p.order_id, transactionReference: p.transaction_id ?? null, paymentMethod: p.payment_type, amount, currency: p.currency ?? 'IDR', receivedAt: new Date().toISOString(), spokenText: `Pembayaran QRIS sebesar ${rupiahToIndonesianWords(amount)} berhasil.` };
      const result = await enqueue(db, event, `midtrans:${event.paymentReference}`);
      return json({ received: true, enqueued: !result.duplicate, duplicate: result.duplicate, eventId: result.event?.id ?? null });
    }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    console.error('Worker request failed:', error.message);
    return json({ error: 'internal_error', message: 'Internal server error' }, 500);
  }
}

export default { fetch: onRequest };
