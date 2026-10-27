import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventStore } from '../src/store.js';
import { handleRequest } from '../src/server.js';

const DEVICE_KEY = 'test-device-key';
const SIMULATOR_KEY = 'test-simulator-key';
const SERVER_KEY = 'test-midtrans-server-key';

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qris-soundbox-'));
  const dataFile = path.join(directory, 'events.jsonl');
  const store = new EventStore(dataFile);
  await store.init();
  const config = {
    nodeEnv: 'development',
    deviceApiKey: DEVICE_KEY,
    simulatorApiKey: SIMULATOR_KEY,
    simulatorEnabled: true,
    sonexLabsApiKey: '',
    midtransWebhookEnabled: false,
    midtransServerKey: '',
    midtransAllowedPaymentType: '',
    ...overrides
  };
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const invoke = async (url, { method = 'GET', key, headerName = 'x-device-key', body, synthesizeSpeech } = {}) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = url;
    request.headers = {};
    if (key !== undefined) request.headers[headerName] = key;
    if (body !== undefined) request.headers['content-type'] = 'application/json';

    const response = {
      status: null,
      headersSent: false,
      headers: {},
      body: '',
      writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(value) { this.body = value ?? ''; },
      destroy() { this.destroyed = true; }
    };
    await handleRequest(request, response, { config, store, synthesizeSpeech });
    return {
      status: response.status,
      headers: response.headers,
      audio: response.body,
      json: async () => JSON.parse(response.body)
    };
  };
  return { invoke, store, dataFile, config };
}

async function post(invoke, url, key, body, headerName = 'x-device-key') {
  return invoke(url, { method: 'POST', key, body, headerName });
}

function signedNotification(overrides = {}) {
  const payload = {
    order_id: 'order-1001',
    status_code: '200',
    gross_amount: '15000.00',
    transaction_status: 'settlement',
    payment_type: 'qris',
    transaction_id: 'transaction-1001',
    currency: 'IDR',
    ...overrides
  };
  payload.signature_key = createHash('sha512')
    .update(`${payload.order_id}${payload.status_code}${payload.gross_amount}${SERVER_KEY}`)
    .digest('hex');
  return payload;
}

test('simulated payment is visibly unverified, idempotent, and can be acknowledged', async (t) => {
  const { invoke } = await setup(t);
  const firstResponse = await post(invoke, '/dev/simulate-payment', SIMULATOR_KEY, {
    amount: 15000,
    idempotencyKey: 'demo-payment-1'
  }, 'x-simulator-key');
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.match(first.warning, /NOT A REAL OR VERIFIED PAYMENT/);
  assert.equal(first.event.isSimulated, true);
  assert.equal(first.event.isVerifiedPayment, false);
  assert.equal(first.event.productionEligible, false);
  assert.equal(first.event.eventType, 'payment_simulated');
  assert.match(first.event.spokenText, /SIMULASI, BUKAN PEMBAYARAN NYATA/);

  const duplicateResponse = await post(invoke, '/dev/simulate-payment', SIMULATOR_KEY, {
    amount: 15000,
    idempotencyKey: 'demo-payment-1'
  }, 'x-simulator-key');
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, first.event.id);

  const pollResponse = await invoke('/api/events', { key: DEVICE_KEY });
  const poll = await pollResponse.json();
  assert.equal(poll.events.length, 1);
  assert.equal(poll.events[0].id, first.event.id);

  const ackResponse = await invoke(`/api/events/${first.event.id}/ack`, { method: 'POST', key: DEVICE_KEY });
  assert.equal(ackResponse.status, 200);
  assert.equal((await ackResponse.json()).acknowledged, true);
  const secondAck = await invoke(`/api/events/${first.event.id}/ack`, { method: 'POST', key: DEVICE_KEY });
  assert.equal((await secondAck.json()).alreadyAcknowledged, true);

  const emptyPoll = await invoke('/api/events', { key: DEVICE_KEY });
  assert.deepEqual((await emptyPoll.json()).events, []);
});

test('simulator and device endpoints require their configured API keys', async (t) => {
  const { invoke } = await setup(t);
  const simulator = await post(invoke, '/dev/simulate-payment', 'wrong-key', { amount: 1000 }, 'x-simulator-key');
  assert.equal(simulator.status, 401);
  const poll = await invoke('/api/events');
  assert.equal(poll.status, 401);
});

test('TTS preview is explicit, simulator-key protected, and returns MP3 audio', async (t) => {
  const { invoke } = await setup(t, { sonexLabsApiKey: 'test-key' });
  const unauthorized = await post(invoke, '/dev/tts-preview', 'wrong-key', { text: 'Uji suara.' }, 'x-simulator-key');
  assert.equal(unauthorized.status, 401);

  let spoken;
  const preview = await invoke('/dev/tts-preview', {
    method: 'POST', key: SIMULATOR_KEY, headerName: 'x-simulator-key', body: { text: '  Pembayaran simulasi.  ' },
    synthesizeSpeech: async (text) => { spoken = text; return Buffer.from('fake-mp3'); }
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['content-type'], 'audio/mpeg');
  assert.equal(preview.audio.toString(), 'fake-mp3');
  assert.equal(spoken, 'Pembayaran simulasi.');
});

test('TTS preview returns a setup hint when no cloud TTS API key exists', async (t) => {
  const { invoke } = await setup(t);
  const response = await post(invoke, '/dev/tts-preview', SIMULATOR_KEY, { text: 'Uji suara.' }, 'x-simulator-key');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'tts_not_configured');
});

test('SonexLabs TTS adapter sends Indonesian text and returns MP3 bytes', async () => {
  const { createSonexSpeech } = await import('../src/integrations/sonex-tts.js');
  let captured;
  const synthesize = createSonexSpeech({
    apiKey: 'secret-for-test',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
    }
  });
  assert.deepEqual(await synthesize('Halo.'), Buffer.from([1, 2, 3]));
  assert.equal(captured.url, 'https://api.sonexlabs.com/v1/speech');
  assert.equal(captured.options.headers.authorization, 'Bearer secret-for-test');
  assert.equal(captured.body.text, 'Halo.');
  assert.equal(captured.body.output_format, 'mp3');
});

test('deduplication and acknowledgements survive reopening the event store', async (t) => {
  const { invoke, dataFile } = await setup(t);
  const created = await post(invoke, '/dev/simulate-payment', SIMULATOR_KEY, {
    amount: 5000,
    idempotencyKey: 'persisted-payment'
  }, 'x-simulator-key');
  const { event } = await created.json();
  const acknowledged = await invoke(`/api/events/${event.id}/ack`, { method: 'POST', key: DEVICE_KEY });
  assert.equal(acknowledged.status, 200);

  const reopened = new EventStore(dataFile);
  await reopened.init();
  const duplicate = await reopened.enqueue({ paymentReference: 'persisted-payment' }, 'simulation:persisted-payment');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, event.id);
  assert.equal(duplicate.event.acknowledgedAt !== null, true);
  assert.deepEqual(await reopened.listPending(), []);
});

test('startup discards only an incomplete final journal line', async (t) => {
  const { invoke, dataFile } = await setup(t);
  const created = await post(invoke, '/dev/simulate-payment', SIMULATOR_KEY, {
    amount: 7500,
    idempotencyKey: 'partial-log-payment'
  }, 'x-simulator-key');
  const { event } = await created.json();
  await fs.appendFile(dataFile, '{"type":"enqueue","event":', 'utf8');

  const reopened = new EventStore(dataFile);
  await reopened.init();
  const duplicate = await reopened.enqueue({ paymentReference: 'partial-log-payment' }, 'simulation:partial-log-payment');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, event.id);
  const journal = await fs.readFile(dataFile, 'utf8');
  assert.match(journal, /\n$/);
  assert.equal(journal.endsWith('{"type":"enqueue","event":'), false);
});

test('Midtrans webhook stays disabled unless explicitly configured', async (t) => {
  const { invoke } = await setup(t);
  const response = await post(invoke, '/webhooks/midtrans', '', { sample: true });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'webhook_disabled');
});

test('enabled Midtrans webhook verifies signature, approved method, payment status, and deduplicates', async (t) => {
  const { invoke } = await setup(t, {
    midtransWebhookEnabled: true,
    midtransServerKey: SERVER_KEY,
    midtransAllowedPaymentType: 'qris'
  });

  const invalid = signedNotification();
  invalid.signature_key = 'bad-signature';
  const invalidResponse = await post(invoke, '/webhooks/midtrans', '', invalid);
  assert.equal(invalidResponse.status, 401);

  const pendingResponse = await post(invoke, '/webhooks/midtrans', '', signedNotification({ transaction_status: 'pending' }));
  assert.equal((await pendingResponse.json()).enqueued, false);

  const wrongMethod = await post(invoke, '/webhooks/midtrans', '', signedNotification({ payment_type: 'gopay' }));
  assert.equal((await wrongMethod.json()).enqueued, false);

  const paid = signedNotification();
  const acceptedResponse = await post(invoke, '/webhooks/midtrans', '', paid);
  const accepted = await acceptedResponse.json();
  assert.equal(acceptedResponse.status, 200);
  assert.equal(accepted.enqueued, true);

  const repeatedResponse = await post(invoke, '/webhooks/midtrans', '', paid);
  assert.equal((await repeatedResponse.json()).duplicate, true);

  const poll = await invoke('/api/events', { key: DEVICE_KEY });
  const event = (await poll.json()).events[0];
  assert.equal(event.provider, 'midtrans');
  assert.equal(event.isVerifiedPayment, true);
  assert.equal(event.isSimulated, false);
  assert.equal(event.paymentMethod, 'qris');
});

test('Midtrans capture with a fraud challenge is not enqueued', async (t) => {
  const { invoke } = await setup(t, {
    midtransWebhookEnabled: true,
    midtransServerKey: SERVER_KEY,
    midtransAllowedPaymentType: 'qris'
  });
  const response = await post(invoke, '/webhooks/midtrans', '', signedNotification({
    transaction_status: 'capture',
    fraud_status: 'challenge'
  }));
  assert.equal((await response.json()).enqueued, false);
});
