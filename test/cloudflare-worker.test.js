import test from 'node:test';
import assert from 'node:assert/strict';
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
