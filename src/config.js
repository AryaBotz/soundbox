import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly "true" or "false"`);
}

export function readConfig() {
  loadDotEnv();

  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');

  const midtransWebhookEnabled = bool('MIDTRANS_WEBHOOK_ENABLED', false);
  const midtransServerKey = process.env.MIDTRANS_SERVER_KEY ?? '';
  const midtransAllowedPaymentType = process.env.MIDTRANS_ALLOWED_PAYMENT_TYPE ?? '';
  if (midtransWebhookEnabled && (!midtransServerKey || !midtransAllowedPaymentType)) {
    throw new Error('Midtrans webhook needs MIDTRANS_SERVER_KEY and MIDTRANS_ALLOWED_PAYMENT_TYPE when enabled');
  }

  const deviceApiKey = process.env.DEVICE_API_KEY ?? '';
  const simulatorApiKey = process.env.SIMULATOR_API_KEY ?? '';
  if (!deviceApiKey) throw new Error('DEVICE_API_KEY is required');
  if (bool('SIMULATOR_ENABLED', false) && process.env.NODE_ENV !== 'production' && !simulatorApiKey) {
    throw new Error('SIMULATOR_API_KEY is required when the development simulator is enabled');
  }

  const dataFile = process.env.DATA_FILE ?? './data/events.jsonl';
  return Object.freeze({
    host: process.env.HOST ?? '0.0.0.0',
    port,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    dataFile: path.resolve(projectRoot, dataFile),
    deviceApiKey,
    simulatorApiKey,
    simulatorEnabled: bool('SIMULATOR_ENABLED', false),
    midtransWebhookEnabled,
    midtransServerKey,
    midtransAllowedPaymentType
  });
}

export { projectRoot };
