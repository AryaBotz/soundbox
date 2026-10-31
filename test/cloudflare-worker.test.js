import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { onRequest } from '../cloudflare/worker.js';

class MemoryD1 {
  rows = [];
  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() {
        if (sql.startsWith('INSERT OR IGNORE')) {
          if (db.rows.some((row) => row.dedupe_key === args[1])) return { meta: { changes: 0 } };
          db.rows.push({ id: args[0], dedupe_key: args[1], event_json: args[2], acknowledged_at: null, audio: null });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE events SET acknowledged_at')) {
          const row = db.rows.find((item) => item.id === args[1]);
          if (row) row.acknowledged_at = args[0];
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.startsWith('UPDATE events SET audio')) {
          const row = db.rows.find((item) => item.id === args[1]);
          if (row) row.audio = args[0];
          return { meta: { changes: row ? 1 : 0 } };
        }
        throw new Error(`Unhandled SQL run: ${sql}`);
      },
      async first() {
        if (sql.includes('COUNT(*)')) return { total: db.rows.length, pending: db.rows.filter((r) => !r.acknowledged_at).length };
        if (sql.includes('WHERE dedupe_key')) return db.rows.find((r) => r.dedupe_key === args[0]) ?? null;
        if (sql.includes('event_json, audio')) return db.rows.find((r) => r.id === args[0]) ?? null;
        if (sql.includes('WHERE id')) return db.rows.find((r) => r.id === args[0]) ?? null;
        throw new Error(`Unhandled SQL first: ${sql}`);
      },
      async all() {
        const limit = args[0];
        return { results: db.rows.filter((r) => !r.acknowledged_at).slice(0, limit) };
      }
    };
  }
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Request(`https://test.example${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('Cloudflare worker provides a protected simulated queue with dedup and ack', async () => {
  const env = { DB: new MemoryD1(), SIMULATOR_ENABLED: 'true', SIMULATOR_API_KEY: 'sim-key', DEVICE_API_KEY: 'device-key', MIDTRANS_WEBHOOK_ENABLED: 'false' };
  const created = await onRequest(request('/dev/simulate-payment', { method: 'POST', headers: { 'x-simulator-key': 'sim-key' }, body: { amount: 15000, idempotencyKey: 'same-id' } }), env);
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.event.isSimulated, true);
  assert.equal(result.event.isVerifiedPayment, false);
  assert.equal(result.event.productionEligible, false);
  assert.match(result.warning, /NOT A REAL OR VERIFIED PAYMENT/);

  const duplicate = await onRequest(request('/dev/simulate-payment', { method: 'POST', headers: { 'x-simulator-key': 'sim-key' }, body: { amount: 15000, idempotencyKey: 'same-id' } }), env);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).event.id, result.event.id);

  const queue = await onRequest(request('/api/events?limit=10', { headers: { 'x-device-key': 'device-key' } }), env);
  assert.equal((await queue.json()).events.length, 1);
  const ack = await onRequest(request(`/api/events/${result.event.id}/ack`, { method: 'POST', headers: { 'x-device-key': 'device-key' } }), env);
  assert.equal((await ack.json()).alreadyAcknowledged, false);
  const again = await onRequest(request(`/api/events/${result.event.id}/ack`, { method: 'POST', headers: { 'x-device-key': 'device-key' } }), env);
  assert.equal((await again.json()).alreadyAcknowledged, true);
});

test('Cloudflare worker rejects missing keys and leaves Midtrans disabled', async () => {
  const env = { DB: new MemoryD1(), SIMULATOR_ENABLED: 'true', SIMULATOR_API_KEY: 'sim-key', DEVICE_API_KEY: 'device-key', MIDTRANS_WEBHOOK_ENABLED: 'false' };
  assert.equal((await onRequest(request('/api/events'), env)).status, 401);
  assert.equal((await onRequest(request('/dev/simulate-payment', { method: 'POST', body: { amount: 100 } }), env)).status, 401);
  assert.equal((await onRequest(request('/webhooks/midtrans', { method: 'POST', body: {} }), env)).status, 503);
});

test('device Basic auth can retrieve audio for a simulated event only', async () => {
  const env = { DB: new MemoryD1(), SIMULATOR_ENABLED: 'true', SIMULATOR_API_KEY: 'sim-key', DEVICE_API_KEY: 'device-key', MIDTRANS_WEBHOOK_ENABLED: 'false' };
  const created = await onRequest(request('/dev/simulate-payment', { method: 'POST', headers: { 'x-simulator-key': 'sim-key' }, body: { amount: 5000, idempotencyKey: 'audio-test' } }), env);
  const event = (await created.json()).event;
  const row = env.DB.rows.find((r) => r.id === event.id);
  row.audio = new Uint8Array([0x49, 0x44, 0x33]);

  const unauthorized = await onRequest(request(`/api/events/${event.id}/audio`), env);
  assert.equal(unauthorized.status, 401);
  const auth = `Basic ${btoa('device:device-key')}`;
  const audio = await onRequest(request(`/api/events/${event.id}/audio`, { headers: { authorization: auth } }), env);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [0x49, 0x44, 0x33]);
});

test('sandbox QRIS creation calls only the GoPay Sandbox API behind the simulator key', async () => {
  let captured;
  const env = {
    DB: new MemoryD1(),
    SIMULATOR_ENABLED: 'true',
    SIMULATOR_API_KEY: 'sim-key',
    MIDTRANS_MODE: 'sandbox',
    MIDTRANS_SERVER_KEY: 'sandbox-server-key',
    MIDTRANS_FETCH: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        json: async () => ({
          transaction_id: 'sandbox-tx-1',
          order_id: captured.body.transaction_details.order_id,
          transaction_status: 'pending',
          actions: [{ name: 'generate-qr-code-v2', url: 'https://api.sandbox.midtrans.com/v4/qris/test/qr-code' }]
        })
      };
    }
  };

  const unauthorized = await onRequest(request('/dev/midtrans-sandbox/qris', {
    method: 'POST', body: { amount: 15000 }
  }), env);
  assert.equal(unauthorized.status, 401);

  const response = await onRequest(request('/dev/midtrans-sandbox/qris', {
    method: 'POST',
    headers: { 'x-simulator-key': 'sim-key' },
    body: { amount: 15000 }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://api.sandbox.midtrans.com/v2/charge');
  assert.equal(captured.options.headers.authorization, `Basic ${btoa('sandbox-server-key:')}`);
  assert.equal(captured.body.payment_type, 'qris');
  assert.deepEqual(captured.body.qris, { acquirer: 'gopay' });
  const result = await response.json();
  assert.equal(result.sandbox, true);
  assert.equal(result.amount, 15000);
  assert.equal(result.qrImageUrl, 'https://api.sandbox.midtrans.com/v4/qris/test/qr-code');
});

test('sandbox Midtrans settlement is labeled non-production, deduplicated by transaction, and gets TTS on device audio request', async () => {
  const serverKey = 'sandbox-server-key';
  let ttsCalls = 0;
  const env = {
    DB: new MemoryD1(),
    DEVICE_API_KEY: 'device-key',
    MIDTRANS_WEBHOOK_ENABLED: 'true',
    MIDTRANS_MODE: 'sandbox',
    MIDTRANS_SERVER_KEY: serverKey,
    MIDTRANS_ALLOWED_PAYMENT_TYPE: 'qris',
    MIDTRANS_ALLOWED_ACQUIRER: 'gopay',
    SONEXLABS_API_KEY: 'test-tts-key',
    SONEXLABS_FETCH: async (_url, options) => {
      ttsCalls += 1;
      assert.match(JSON.parse(options.body).text, /UJI MIDTRANS SANDBOX/);
      return { ok: true, headers: { get: () => null }, arrayBuffer: async () => Uint8Array.from([0x49, 0x44, 0x33]).buffer };
    }
  };

  const payload = {
    order_id: 'sandbox-order-1',
    status_code: '200',
    gross_amount: '15000.00',
    transaction_status: 'settlement',
    payment_type: 'qris',
    transaction_id: 'sandbox-tx-unique-1',
    acquirer: 'gopay',
    currency: 'IDR',
    fraud_status: 'accept'
  };
  payload.signature_key = createHash('sha512')
    .update(`${payload.order_id}${payload.status_code}${payload.gross_amount}${serverKey}`)
    .digest('hex');

  const notification = await onRequest(request('/webhooks/midtrans', { method: 'POST', body: payload }), env);
  const first = await notification.json();
  assert.equal(first.sandbox, true);
  assert.equal(first.enqueued, true);

  const duplicate = await onRequest(request('/webhooks/midtrans', { method: 'POST', body: payload }), env);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(env.DB.rows.length, 1);

  const stored = JSON.parse(env.DB.rows[0].event_json);
  assert.equal(stored.isSandbox, true);
  assert.equal(stored.isSimulated, true);
  assert.equal(stored.isVerifiedPayment, false);
  assert.equal(stored.productionEligible, false);
  assert.equal(env.DB.rows[0].dedupe_key, 'midtrans:sandbox-tx-unique-1');

  const auth = `Basic ${btoa('device:device-key')}`;
  const audio = await onRequest(request(`/api/events/${first.eventId}/audio`, { headers: { authorization: auth } }), env);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [0x49, 0x44, 0x33]);
  assert.equal(ttsCalls, 1);
});
