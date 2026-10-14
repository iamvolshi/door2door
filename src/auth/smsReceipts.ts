import * as crypto from 'node:crypto';
import { logger } from '../core/logger';
import type { OtpDeliveryRepository } from '../db/repositories';
import type { OtpDeliveryRecord, SmsReceiptState } from '../db/schema';

/**
 * Delivery reports from an SMS gateway: what actually happened to a message once it left.
 *
 * `otp_deliveries` records the *accepted* send — a `202` or a `SENT` means the gateway took the
 * message, which is the strongest thing the send call can say. Whether the handset ever got it
 * is a second, later fact that only the gateway knows, and it arrives on a route of its own.
 * This module reads those reports and writes them onto the attempt they describe.
 *
 * Nothing here trusts a provider's payload shape. Neither gateway this platform sends through
 * documents a delivery-report contract publicly, so the reader is deliberately tolerant: it
 * looks for the fields a report must carry under the names gateways commonly use, records the
 * names it read and the values it took verbatim, and answers `UNKNOWN` — not a guess — when it
 * cannot tell what a report is saying. A receipt that cannot be read is still a receipt: it is
 * stored with the gateway's own words beside a warning in the log.
 */

/** How far back a receipt may be matched to an attempt by phone number alone. */
export const RECEIPT_PHONE_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many attempts for one number are considered a receipt's candidates. */
export const RECEIPT_PHONE_MATCH_LIMIT = 10;

export interface ParsedSmsReceipt {
  /** Lowercase provider name when the report names one, else null. */
  provider: string | null;
  messageId: string | null;
  /** Normalized to `+8801…` when the report carries a recognizable number. */
  phone: string | null;
  state: SmsReceiptState;
  /** The gateway's own word, exactly as reported — `DELIVRD`, `202`, `expired`, whatever it is. */
  statusToken: string | null;
  reason: string | null;
  /** What was read: the field names this report was interpreted from, and the values taken. */
  fields: Record<string, string>;
}

export interface SmsReceiptOutcome {
  matched: boolean;
  /** How the attempt was found. A receipt matched by number is a weaker claim than one by id. */
  matchedBy: 'messageId' | 'phone' | null;
  deliveryId: string | null;
  /** Attempts for that number that could have been what this report describes. */
  candidates: number;
  state: SmsReceiptState;
  statusToken: string | null;
  reason: string | null;
}

/**
 * Field names a report's parts are looked for under, in order of preference.
 *
 * `id` is last because it is the name most likely to mean something else — a gateway's own
 * event id, a customer's order number — while `sms_id`, `message_id` and the like can only be
 * the reference to the message. `number` and `to` are the reverse: the shortest names are the
 * ones gateways actually use for the handset.
 */
const MESSAGE_ID_FIELDS = [
  'messageid',
  'message_id',
  'messagesid',
  'msgid',
  'msg_id',
  'smsid',
  'sms_id',
  'dlrid',
  'dlr_id',
  'reference',
  'ref',
  'message_reference',
  'requestid',
  'request_id',
  'id'
] as const;

const PHONE_FIELDS = [
  'phone',
  'mobile',
  'msisdn',
  'number',
  'to',
  'recipient',
  'recipient_no',
  'destination',
  'handset',
  'mobileno',
  'mobile_no'
] as const;

const STATUS_FIELDS = [
  'status',
  'statusmsg',
  'status_msg',
  'deliverystatus',
  'delivery_status',
  'dlr',
  'dlrstatus',
  'dlr_status',
  'state',
  'result',
  'report',
  'event',
  'response_code',
  'code'
] as const;

const REASON_FIELDS = [
  'reason',
  'error_message',
  'errmsg',
  'err_msg',
  'statusdesc',
  'status_desc',
  'description',
  'detail',
  'note',
  'remark',
  'cause',
  'message'
] as const;

const PROVIDER_FIELDS = ['provider', 'gateway', 'sms_provider', 'channel', 'operator', 'sender'] as const;

/**
 * Status words that mean the handset took the message.
 *
 * This list is a vocabulary, not a contract: no gateway documentation backs it, so it holds
 * only words whose meaning is unambiguous in a delivery report. Anything outside it — including
 * every numeric code, which gateways use for both submission and delivery — reads as `UNKNOWN`
 * with the token preserved, because claiming a handset receipt we did not read would be worse
 * than saying plainly that the report could not be interpreted.
 */
const DELIVERED_TOKENS = new Set([
  'DELIVERED',
  'DELIVRD',
  'DELIVER',
  'DELIVEREDTOHANDSET',
  'DELIVEREDTOPHONE',
  'HANDSETDELIVERED',
  'SUCCESS',
  'SUCCESSFUL',
  'OK',
  'DONE',
  'RECEIVED',
  'COMPLETED'
]);

/** Words that mean it did not arrive, and are not merely a waiter being told to wait. */
const FAILED_TOKENS = new Set([
  'FAILED',
  'FAIL',
  'FAILURE',
  'UNDELIVERED',
  'UNDELIV',
  'UNDELIVERABLE',
  'NOTDELIVERED',
  'REJECTED',
  'REJECT',
  'EXPIRED',
  'BLOCKED',
  'BLACKLISTED',
  'ABSENTSUBSCRIBER',
  'UNKNOWNSUBSCRIBER',
  'INVALIDNUMBER',
  'INVALIDDESTINATION',
  'NOANSWER',
  'UNAVAILABLE',
  'ERROR',
  'DENIED'
]);

function normalizeToken(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Turns whatever word a report used into one of three answers.
 *
 * Anything unrecognised is `UNKNOWN`, which is also the answer for the words that mean "on its
 * way" (`PENDING`, `QUEUED`, `SUBMITTED`, `SENT`) — a report saying a message was submitted
 * tells us nothing about the handset that the send call had not already told us.
 */
export function interpretReceiptStatus(token: string | null): SmsReceiptState {
  if (token === null) return 'UNKNOWN';
  const normalized = normalizeToken(token);
  if (normalized === '') return 'UNKNOWN';
  if (DELIVERED_TOKENS.has(normalized)) return 'DELIVERED';
  if (FAILED_TOKENS.has(normalized)) return 'FAILED';
  return 'UNKNOWN';
}

/** Finds the first present, non-empty value among a set of candidate field names. */
function pick(
  source: Record<string, unknown>,
  fields: readonly string[]
): { field: string; value: string } | null {
  const lowercased = new Map<string, { field: string; value: string }>();
  for (const [key, raw] of Object.entries(source)) {
    const normalizedKey = key.trim().toLowerCase();
    if (lowercased.has(normalizedKey)) continue;
    const value =
      typeof raw === 'string'
        ? raw.trim()
        : typeof raw === 'number' || typeof raw === 'boolean'
          ? String(raw)
          : null;
    if (value === null || value === '') continue;
    lowercased.set(normalizedKey, { field: key, value });
  }

  for (const field of fields) {
    const found = lowercased.get(field);
    if (found) return found;
  }
  return null;
}

/** Normalizes anything that looks like a phone number to `+8801…`, or null. */
function normalizeReceiptPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (/^8801[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^01[3-9]\d{8}$/.test(digits)) return `+88${digits}`;
  return null;
}

/**
 * Reads a delivery report out of whatever a gateway sent.
 *
 * `fallbackProvider` is the gateway this deployment actually sends through, used only when the
 * report does not name one — the app knows, the gateway does not have to say.
 *
 * One level of nesting is unwrapped: some gateways wrap the report (`{ "data": { … } }`,
 * `{ "report": { … } }`). Rather than guess which key, the reader descends when the top level
 * named no reference and no number — the two things that say a level *is* the report — and
 * exactly one of its properties is an object. A wrapper's own `event` or `type` tag does not
 * stop it, because a tag is not a statement about the handset; a top level that carries a
 * status of its own with no envelope to open is left alone, so reading a report never means
 * discarding what it said in favour of what an unrelated nested object happens to contain.
 */
export function parseSmsReceipt(
  payload: Record<string, unknown>,
  options: { fallbackProvider?: string | null } = {}
): ParsedSmsReceipt {
  const fields: Record<string, string> = {};

  let source = payload;
  let messageId = pick(source, MESSAGE_ID_FIELDS);
  let phone = pick(source, PHONE_FIELDS);
  let status = pick(source, STATUS_FIELDS);

  if (!messageId && !phone) {
    const nested = Object.entries(source).filter(
      ([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value)
    );
    if (nested.length === 1) {
      const [key, value] = nested[0];
      const inner = value as Record<string, unknown>;
      const innerMessageId = pick(inner, MESSAGE_ID_FIELDS);
      const innerPhone = pick(inner, PHONE_FIELDS);
      const innerStatus = pick(inner, STATUS_FIELDS);

      // Descended when the inner object names the message or the handset — that is what makes
      // it the report — or when the wrapper had no status of its own to lose.
      if (innerMessageId || innerPhone || (!status && innerStatus)) {
        source = inner;
        messageId = innerMessageId;
        phone = innerPhone;
        status = innerStatus ?? status;
        fields.nestedUnder = key;
      }
    }
  }

  const reason = pick(source, REASON_FIELDS);
  const providerField = pick(source, PROVIDER_FIELDS);
  const provider = (providerField?.value ?? options.fallbackProvider ?? '').trim().toLowerCase();

  if (messageId) fields[messageId.field] = messageId.value;
  if (phone) fields[phone.field] = phone.value;
  if (status) fields[status.field] = status.value;
  if (reason && reason.field !== status?.field) fields[reason.field] = reason.value;
  if (providerField) fields[providerField.field] = providerField.value;

  return {
    provider: provider === '' ? null : provider,
    messageId: messageId?.value ?? null,
    phone: normalizeReceiptPhone(phone?.value ?? null),
    state: interpretReceiptStatus(status?.value ?? null),
    statusToken: status?.value ?? null,
    reason: reason?.value ?? null,
    fields
  };
}

/**
 * Compares a presented webhook secret with the configured one.
 *
 * Both sides are hashed to a fixed length first, so the comparison is over equal-length buffers
 * and reveals nothing about the secret's length; the comparison itself is constant-time, so a
 * caller cannot learn the secret one character at a time from how long a refusal took.
 */
export function receiptSecretMatches(presented: string, expected: string): boolean {
  if (expected === '') return false;
  const given = crypto.createHash('sha256').update(presented).digest();
  const want = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(given, want);
}

/**
 * Header names a gateway's shared secret is accepted under, in the order they are read.
 *
 * Several names because a gateway is configured with a header of *its* choosing and neither
 * of the two providers this platform sends through documents a delivery-report contract at
 * all: refusing a report because the secret arrived under a name we did not anticipate would
 * throw away the only evidence that a handset received a code. `x-api-key` is last of the
 * recognized names because it is the one most likely to be the gateway's own API key rather
 * than the callback secret — accepted, since a deployment that puts the same value in both is
 * not a security failure here, but a wrong value is still refused.
 */
const SECRET_HEADERS = [
  'x-webhook-secret',
  'x-sms-secret',
  'x-receipt-secret',
  'x-callback-secret',
  'x-auth-token',
  'x-api-key'
] as const;

/** Reads the secret out of whichever channel the gateway used. */
export function presentedWebhookSecret(input: {
  headers?: Record<string, string | string[] | undefined>;
  query: URLSearchParams;
}): string | null {
  for (const name of SECRET_HEADERS) {
    const raw = input.headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && value.trim() !== '') return value.trim();
  }

  const rawAuthorization = input.headers?.authorization;
  const authorization = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  // Last, because a secret in a URL ends up in access logs and browser history that are not
  // ours; some gateways can only be configured with a callback URL and no headers, so it is
  // supported rather than refused.
  const fromQuery = input.query.get('secret');
  if (fromQuery && fromQuery.trim() !== '') return fromQuery.trim();
  return null;
}

/**
 * Writes delivery reports onto the attempts they describe.
 *
 * Matching is by the gateway's own reference to the message when the report carries one, and by
 * the number otherwise — Greenweb, for one, returns no per-message id at all. A match by number
 * takes the newest attempt for that number inside a day and records how many attempts it could
 * have been, because that is the honest strength of the claim: the row says `matchedBy: 'phone'`
 * and `candidates: 3` rather than presenting a number match as an identification.
 */
export class SmsReceiptService {
  constructor(private readonly repo: OtpDeliveryRepository) {}

  public async ingest(
    receipt: ParsedSmsReceipt,
    options: { receivedAt?: string; matchWindowMs?: number; requestId?: string } = {}
  ): Promise<SmsReceiptOutcome> {
    const receivedAt = options.receivedAt ?? new Date().toISOString();
    const matchWindowMs = options.matchWindowMs ?? RECEIPT_PHONE_MATCH_WINDOW_MS;

    let target: OtpDeliveryRecord | null = null;
    let matchedBy: 'messageId' | 'phone' | null = null;
    let candidates = 0;

    if (receipt.messageId && receipt.provider) {
      target = await this.repo.findByMessageId(receipt.provider, receipt.messageId);
      if (target) {
        matchedBy = 'messageId';
        candidates = 1;
      }
    }

    if (!target && receipt.phone) {
      const since = new Date(Date.parse(receivedAt) - matchWindowMs).toISOString();
      const attempts = await this.repo.findForPhoneSince(
        receipt.phone,
        since,
        RECEIPT_PHONE_MATCH_LIMIT
      );
      candidates = attempts.length;
      if (attempts.length > 0) {
        target = attempts[0];
        matchedBy = 'phone';
      }
    }

    const detail: Record<string, unknown> = {
      state: receipt.state,
      statusToken: receipt.statusToken,
      reason: receipt.reason,
      matchedBy,
      messageId: receipt.messageId,
      phone: receipt.phone,
      provider: receipt.provider,
      candidates,
      receivedAt,
      // The request that carried the report, so the row can be followed into the request log
      // line for the same call — which is where the caller's address is recorded, and the
      // only place it is: the gateway's address is not a customer's, so it is not copied
      // into a table the retention sweep rewrites.
      requestId: options.requestId ?? null,
      // The field names this report was read from and the values taken, so a gateway that
      // changes its payload shape is diagnosable from the row rather than from a log that
      // has already rotated away.
      fields: receipt.fields
    };

    if (!target) {
      // Nothing to attach it to: the attempt may have been pruned (30-day retention), may
      // belong to another deployment sharing this database, or the report may name neither a
      // reference we stored nor a number we sent to. Said out loud rather than stored, because
      // an unmatched report in a table of attempts would read as an attempt.
      logger.warn('SMS delivery report matched no attempt', {
        provider: receipt.provider,
        messageId: receipt.messageId,
        phone: receipt.phone,
        statusToken: receipt.statusToken,
        state: receipt.state
      });
      return {
        matched: false,
        matchedBy: null,
        deliveryId: null,
        candidates: 0,
        state: receipt.state,
        statusToken: receipt.statusToken,
        reason: receipt.reason
      };
    }

    const updated = await this.repo.recordReceipt(target.id, { state: receipt.state, detail });
    if (!updated) {
      // The attempt was pruned between the read and the write. Reported the same way as an
      // unmatched report, because that is what it became.
      logger.warn('SMS delivery report arrived for an attempt that is gone', {
        deliveryId: target.id,
        state: receipt.state
      });
      return {
        matched: false,
        matchedBy: null,
        deliveryId: null,
        candidates: 0,
        state: receipt.state,
        statusToken: receipt.statusToken,
        reason: receipt.reason
      };
    }

    logger.info('SMS delivery report recorded', {
      deliveryId: updated.id,
      state: updated.receiptState,
      statusToken: receipt.statusToken,
      matchedBy,
      candidates
    });

    return {
      matched: true,
      matchedBy,
      deliveryId: updated.id,
      candidates,
      state: receipt.state,
      statusToken: receipt.statusToken,
      reason: receipt.reason
    };
  }
}
