import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyMidtransSignature(payload, serverKey) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const { order_id: orderId, status_code: statusCode, gross_amount: grossAmount, signature_key: signature } = payload;
  if (![orderId, statusCode, grossAmount, signature].every((value) => typeof value === 'string' && value.length > 0)) return false;

  const expected = createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`, 'utf8')
    .digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function isApprovedPaidNotification(payload, allowedPaymentType) {
  if (payload.payment_type !== allowedPaymentType) return false;
  if (payload.currency && payload.currency !== 'IDR') return false;
  if (!['settlement', 'capture'].includes(payload.transaction_status)) return false;
  if (payload.fraud_status !== undefined && payload.fraud_status !== 'accept') return false;
  return true;
}

export function toMidtransEvent(payload) {
  const amount = Number(payload.gross_amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    provider: 'midtrans',
    eventType: 'payment_confirmed',
    source: 'midtrans_webhook',
    verificationStatus: 'provider_signature_verified',
    isVerifiedPayment: true,
    isSimulated: false,
    productionEligible: true,
    paymentReference: payload.order_id,
    transactionReference: payload.transaction_id ?? null,
    paymentMethod: payload.payment_type,
    amount,
    currency: payload.currency ?? 'IDR',
    receivedAt: new Date().toISOString(),
    spokenText: `Pembayaran QRIS sebesar ${Math.round(amount)} rupiah berhasil.`
  };
}
