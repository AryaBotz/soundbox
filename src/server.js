import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { EventStore } from './store.js';
import { isApprovedPaidNotification, toMidtransEvent, verifyMidtransSignature } from './integrations/midtrans.js';

const BODY_LIMIT = 16 * 1024;

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().includes('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object');
    return parsed;
  } catch {
    const error = new Error('Body must contain valid JSON object');
    error.statusCode = 400;
    throw error;
  }
}

function secretMatches(value, expected) {
  if (typeof value !== 'string' || !expected) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireKey(request, response, expected, headerName = 'x-device-key') {
  if (secretMatches(request.headers[headerName], expected)) return true;
  sendJson(response, 401, { error: 'unauthorized', message: `Missing or invalid ${headerName}` });
  return false;
}

function validateSimulation(body) {
  const amount = body.amount;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000_000) {
    return 'amount must be an integer rupiah amount from 1 to 100000000';
  }
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 1 || body.idempotencyKey.length > 120)) {
    return 'idempotencyKey must be a string from 1 to 120 characters';
  }
  return null;
}

export async function handleRequest(request, response, { config, store }) {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      const stats = await store.stats();
      return sendJson(response, 200, {
        status: 'ok',
        mode: config.nodeEnv,
        simulatorEnabled: config.simulatorEnabled && config.nodeEnv !== 'production',
        midtransWebhookEnabled: config.midtransWebhookEnabled,
        queue: stats
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      if (!requireKey(request, response, config.deviceApiKey)) return;
      const parsedLimit = Number(url.searchParams.get('limit') ?? 10);
      const limit = Number.isInteger(parsedLimit) ? Math.min(50, Math.max(1, parsedLimit)) : 10;
      const events = await store.listPending(limit);
      return sendJson(response, 200, {
        events,
        pollAfterMs: 2000,
        notice: 'Events may repeat until acknowledged. Deduplicate on the ESP32 by event id.'
      });
    }

    const ackMatch = request.method === 'POST' && url.pathname.match(/^\/api\/events\/([0-9a-f-]{36})\/ack$/i);
    if (ackMatch) {
      if (!requireKey(request, response, config.deviceApiKey)) return;
      const result = await store.acknowledge(ackMatch[1]);
      if (!result.found) return sendJson(response, 404, { error: 'event_not_found' });
      return sendJson(response, 200, {
        eventId: result.event.id,
        acknowledged: true,
        alreadyAcknowledged: result.alreadyAcknowledged
      });
    }

    if (request.method === 'POST' && url.pathname === '/dev/simulate-payment') {
      if (!config.simulatorEnabled || config.nodeEnv === 'production') {
        return sendJson(response, 404, { error: 'not_found' });
      }
      if (!requireKey(request, response, config.simulatorApiKey, 'x-simulator-key')) return;
      const body = await readJson(request);
      const validationError = validateSimulation(body);
      if (validationError) return sendJson(response, 400, { error: 'invalid_request', message: validationError });
      const event = {
        provider: 'simulation',
        eventType: 'payment_simulated',
        source: 'development_simulator',
        verificationStatus: 'simulated_unverified',
        isVerifiedPayment: false,
        isSimulated: true,
        productionEligible: false,
        paymentReference: body.idempotencyKey ?? `sim-${randomUUID()}`,
        paymentMethod: 'simulated_qris',
        amount: body.amount,
        currency: 'IDR',
        receivedAt: new Date().toISOString(),
        spokenText: `SIMULASI, BUKAN PEMBAYARAN NYATA. ${body.amount} rupiah diterima dalam simulasi.`
      };
      const result = await store.enqueue(event, `simulation:${event.paymentReference}`);
      return sendJson(response, result.duplicate ? 200 : 201, {
        warning: 'SIMULATION ONLY — NOT A REAL OR VERIFIED PAYMENT',
        duplicate: result.duplicate,
        event: result.event
      });
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/midtrans') {
      if (!config.midtransWebhookEnabled) {
        return sendJson(response, 503, { error: 'webhook_disabled', message: 'Midtrans webhook is disabled pending payment-method approval and configuration' });
      }
      const body = await readJson(request);
      if (!verifyMidtransSignature(body, config.midtransServerKey)) {
        return sendJson(response, 401, { error: 'invalid_midtrans_signature' });
      }
      if (!isApprovedPaidNotification(body, config.midtransAllowedPaymentType)) {
        return sendJson(response, 200, { received: true, enqueued: false, reason: 'not_an_approved_successful_payment' });
      }
      const event = toMidtransEvent(body);
      if (!event) return sendJson(response, 400, { error: 'invalid_gross_amount' });
      const result = await store.enqueue(event, `midtrans:${event.paymentReference}`);
      return sendJson(response, 200, {
        received: true,
        enqueued: !result.duplicate,
        duplicate: result.duplicate,
        eventId: result.event?.id ?? null
      });
    }

    return sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error.statusCode ?? 500, {
        error: error.statusCode ? 'request_error' : 'internal_error',
        message: error.statusCode ? error.message : 'Internal server error'
      });
    } else {
      response.destroy();
    }
  }
}

export function createServer({ config, store }) {
  return http.createServer((request, response) => {
    void handleRequest(request, response, { config, store });
  });
}

async function main() {
  const config = readConfig();
  const store = new EventStore(config.dataFile);
  await store.init();
  const server = createServer({ config, store });
  server.listen(config.port, config.host, () => {
    console.log(`QRIS Soundbox backend listening on http://${config.host}:${config.port}`);
    console.log(`Simulator: ${config.simulatorEnabled && config.nodeEnv !== 'production' ? 'enabled (unverified development events only)' : 'disabled'}`);
    console.log(`Midtrans webhook: ${config.midtransWebhookEnabled ? `enabled for payment_type=${config.midtransAllowedPaymentType}` : 'disabled'}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
