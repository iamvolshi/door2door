import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseSmsReceipt,
  presentedWebhookSecret,
  receiptSecretMatches
} from '../src/auth/smsReceipts';
import { OtpDeliveryRepository, parseReceiptDetail } from '../src/db/repositories';
import { serializeDelivery } from '../src/http/routes/adminRoutes';
import {
  SEEDED,
  apiRequest,
  createTempDatabaseDir,
  getJson,
  login,
  postJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

const DELIVERY_REPORT_PATH = '/api/v1/webhooks/sms-delivery-reports';

/** The secret the gateway is given in this suite; the deployment's own is in the environment. */
const SECRET = 'test-delivery-report-secret';

/**
 * Delivery reports: the gateway's second word about a message, which is the only thing that
 * separates "the gateway accepted it" from "the handset received it".
 *
 * The parser half is a pure function table. The integration half runs a real server against a
 * real database and posts receipts at it, because the parts that can go wrong quietly are the
 * wiring ones: a report that arrives and is written nowhere, a match that lands on the wrong
 * row, a secret that is checked on one route and not the other.
 */
describe('reading a delivery report out of what a gateway sends', () => {
  it('reads a delivered report, naming the fields it was read from', () => {
    const receipt = parseSmsReceipt({
      sms_id: 'gw-77',
      number: '8801700000001',
      status: 'DELIVRD'
    });

    expect(receipt.state).toBe('DELIVERED');
    expect(receipt.messageId).toBe('gw-77');
    expect(receipt.phone).toBe('+8801700000001');
    expect(receipt.provider).toBeNull();
    // Recorded verbatim, so a gateway that changes its field names is diagnosable from the row
    // rather than from a log that has already rotated away.
    expect(receipt.fields).toMatchObject({
      sms_id: 'gw-77',
      number: '8801700000001',
      status: 'DELIVRD'
    });
  });

  it('treats a submission acknowledgement as no news about the handset', () => {
    // Every one of these is a fact the send call already recorded. Reading them as delivery
    // would make the receipt column mean two different things.
    for (const token of ['SENT', 'PENDING', 'QUEUED', 'Submitted', 'processing']) {
      const receipt = parseSmsReceipt({ message_id: 'gw-78', status: token });
      expect(receipt.state, `${token} was read as a handset receipt`).toBe('UNKNOWN');
      expect(receipt.statusToken).toBe(token);
    }
  });

  it('does not guess at a numeric code, because gateways use codes for both events', () => {
    const receipt = parseSmsReceipt({ message_id: 'gw-79', status: '202' });
    expect(receipt.state).toBe('UNKNOWN');
    // Kept, so an operator reading the row can see the gateway did report something.
    expect(receipt.statusToken).toBe('202');
    expect(receipt.reason).toBeNull();
  });

  it('reads a failure and the gateway’s own reason for it', () => {
    const receipt = parseSmsReceipt({
      message_id: 'gw-80',
      recipient: '8801700000002',
      delivery_status: 'Expired',
      error_message: 'Absent subscriber'
    });

    expect(receipt.state).toBe('FAILED');
    expect(receipt.reason).toBe('Absent subscriber');
  });

  it('unwraps the envelope a gateway nests its report in', () => {
    const receipt = parseSmsReceipt({
      event: 'delivery',
      data: { message_id: 'gw-81', mobile: '01700000003', status: 'DELIVERED' }
    });

    expect(receipt.state).toBe('DELIVERED');
    expect(receipt.messageId).toBe('gw-81');
    expect(receipt.phone).toBe('+8801700000003');
    expect(receipt.fields.nestedUnder).toBe('data');
  });

  it('accepts a number however the gateway writes it, and refuses one that is not a number', () => {
    const written = (number: string) => parseSmsReceipt({ msgid: 'gw-82', msisdn: number }).phone;
    expect(written('8801700000004')).toBe('+8801700000004');
    expect(written('01700000004')).toBe('+8801700000004');
    expect(written('+880 1700-000004')).toBe('+8801700000004');

    // An unrecognisable value is dropped rather than stored: matching on it would be a match on
    // something the platform never sent to.
    expect(parseSmsReceipt({ msgid: 'gw-83', msisdn: 'unknown' }).phone).toBeNull();
  });

  it('assumes the gateway this deployment sends through when the report does not say', () => {
    const receipt = parseSmsReceipt(
      { msgid: 'gw-84', status: 'DELIVRD' },
      { fallbackProvider: 'greenweb' }
    );
    expect(receipt.provider).toBe('greenweb');
  });

  it('reads nothing at all out of a payload that says nothing, without inventing a state', () => {
    const receipt = parseSmsReceipt({ ping: true, healthy: 1 });
    expect(receipt.messageId).toBeNull();
    expect(receipt.phone).toBeNull();
    expect(receipt.state).toBe('UNKNOWN');
    expect(receipt.statusToken).toBeNull();
  });
});

describe('the shared secret that authorises a report', () => {
  it('matches only the configured value, and never an empty one', () => {
    expect(receiptSecretMatches(SECRET, SECRET)).toBe(true);
    expect(receiptSecretMatches(`${SECRET} `, SECRET)).toBe(false);
    expect(receiptSecretMatches(SECRET, `${SECRET}x`)).toBe(false);
    // An unconfigured deployment must not accept the empty string as a password.
    expect(receiptSecretMatches('', '')).toBe(false);
  });

  it('finds the secret in whichever channel the gateway can be configured to use', () => {
    const query = new URLSearchParams('secret=from-query');
    expect(presentedWebhookSecret({ headers: { 'x-webhook-secret': 'a' }, query })).toBe('a');
    expect(presentedWebhookSecret({ headers: { 'x-api-key': 'b' }, query })).toBe('b');
    expect(presentedWebhookSecret({ headers: { authorization: 'Bearer c' }, query })).toBe('c');
    expect(presentedWebhookSecret({ headers: {}, query })).toBe('from-query');
    expect(presentedWebhookSecret({ headers: {}, query: new URLSearchParams() })).toBeNull();
    // A header that carries something else entirely is not a secret.
    expect(
      presentedWebhookSecret({ headers: { authorization: 'Basic dXNlcjpwYXNz' }, query: new URLSearchParams() })
    ).toBeNull();
  });
});

describe('delivery reports arriving at the API', () => {
  let tempDir: string;
  let app: RunningServer;
  /** The same deployment with no secret configured, which is the default one. */
  let unconfigured: RunningServer;
  let deliveryRepo: OtpDeliveryRepository;
  let adminToken: string;
  let fixtures = 0;

  const receiptHeaders = { 'x-webhook-secret': SECRET };

  /** A dispatch the OTP path wrote, as the mock provider leaves it: no gateway reference. */
  async function dispatch(phone: string): Promise<{ id: string }> {
    const request = await postJson(app, '/api/v1/auth/otp/request', { phone });
    expect(request.status).toBe(200);
    const rows = await app.client.query<{ id: string }>(
      `SELECT id FROM otp_deliveries WHERE phone = ? ORDER BY createdAt DESC LIMIT 1`,
      [phone]
    );
    expect(rows.rows).toHaveLength(1);
    return rows.rows[0];
  }

  /** An attempt as a real gateway would have recorded it, with a reference of its own. */
  async function recordAttempt(overrides: {
    phone: string;
    provider?: string;
    messageId?: string | null;
  }): Promise<{ id: string }> {
    fixtures += 1;
    return deliveryRepo.create({
      id: `otpd_fixture_${fixtures}`,
      phone: overrides.phone,
      provider: overrides.provider ?? 'bulksmsbd',
      delivered: true,
      providerStatus: '202',
      failureCode: null,
      failureReason: null,
      messageId: overrides.messageId ?? null,
      attempts: 1,
      latencyMs: 140,
      requestId: null,
      ipAddress: null
    });
  }

  async function stored(id: string): Promise<{ receiptState: string; detail: any }> {
    const rows = await app.client.query<{ receiptState: string; receiptDetail: string | null }>(
      `SELECT receiptState, receiptDetail FROM otp_deliveries WHERE id = ?`,
      [id]
    );
    expect(rows.rows, `no attempt row ${id}`).toHaveLength(1);
    return { receiptState: rows.rows[0].receiptState, detail: parseReceiptDetail(rows.rows[0].receiptDetail) };
  }

  beforeAll(async () => {
    tempDir = createTempDatabaseDir();
    const databaseFile = `${tempDir}/sms-receipts.sqlite`;
    app = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile,
      rateLimit: { max: 5000, windowMs: 60000 },
      receiptWebhookSecret: SECRET
    });
    // The same platform, started the way it starts when nobody has configured a secret.
    unconfigured = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseFile,
      seed: false,
      rateLimit: { max: 5000, windowMs: 60000 },
      receiptWebhookSecret: ''
    });
    deliveryRepo = new OtpDeliveryRepository(app.client);
    adminToken = (await login(app, SEEDED.admin.phone)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await unconfigured?.close();
    removeTempDatabaseDir(tempDir);
  });

  it('writes the handset outcome onto the attempt the report names', async () => {
    const attempt = await recordAttempt({
      phone: '+8801700000010',
      messageId: 'BULK-9001'
    });

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      {
        provider: 'bulksmsbd',
        message_id: 'BULK-9001',
        recipient: '8801700000010',
        status: 'DELIVRD'
      },
      { headers: receiptHeaders }
    );

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(true);
    expect(response.body.matchedBy).toBe('messageId');
    expect(response.body.deliveryId).toBe(attempt.id);
    expect(response.body.state).toBe('DELIVERED');

    const row = await stored(attempt.id);
    expect(row.receiptState).toBe('DELIVERED');
    // The gateway's own word, the correlation, and the request that carried it.
    expect(row.detail).toMatchObject({ statusToken: 'DELIVRD', matchedBy: 'messageId' });
    expect(String(row.detail?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('matches by the number when the gateway reports no reference of its own', async () => {
    // Greenweb returns no per-message id at all, so the number is all a report has in common
    // with the row it describes — the weakest kind of match, and the only one available.
    const attempt = await recordAttempt({ phone: '+8801700000011' });

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { msisdn: '8801700000011', dlr: 'DELIVRD' },
      { headers: receiptHeaders }
    );

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(true);
    expect(response.body.matchedBy).toBe('phone');
    expect(response.body.candidates).toBe(1);
    expect(response.body.deliveryId).toBe(attempt.id);

    const row = await stored(attempt.id);
    // How the row was found is stored with the outcome: a match by number is a weaker claim
    // than one by reference, and the row should not read as though it were the stronger one.
    expect(row.detail).toMatchObject({ matchedBy: 'phone', candidates: 1 });
  });

  it('reports rather than guesses when the number has several candidate attempts', async () => {
    const first = await recordAttempt({ phone: '+8801700000012' });
    const second = await recordAttempt({ phone: '+8801700000012' });
    // Ordered explicitly: two rows written in the same millisecond would otherwise make "the
    // newest attempt" a coin toss, which is the one thing this match must not be.
    await app.client.query(`UPDATE otp_deliveries SET createdAt = ? WHERE id = ?`, [
      new Date(Date.now() - 60 * 1000).toISOString(),
      first.id
    ]);

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { number: '8801700000012', status: 'UNDELIVERED' },
      { headers: receiptHeaders }
    );

    expect(response.body.matchedBy).toBe('phone');
    expect(response.body.candidates).toBe(2);
    // The newest attempt is the one it describes; the older one is left as it was.
    expect(response.body.deliveryId).toBe(second.id);
    expect(response.body.state).toBe('FAILED');
    expect((await stored(second.id)).receiptState).toBe('FAILED');
    expect((await stored(first.id)).receiptState).toBe('UNKNOWN');
  });

  it('keeps a reference from one gateway from matching another gateway’s row', async () => {
    // Two gateways numbering their own messages from one are two reference spaces. A receipt
    // written onto the wrong one would put a stranger's delivery on this attempt.
    const attempt = await recordAttempt({
      phone: '+8801700000013',
      provider: 'bulksmsbd',
      messageId: 'SHARED-100'
    });

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { provider: 'greenweb', message_id: 'SHARED-100', status: 'DELIVRD' },
      { headers: receiptHeaders }
    );

    expect(response.body.matched).toBe(false);
    expect(response.body.candidates).toBe(0);
    expect((await stored(attempt.id)).receiptState).toBe('UNKNOWN');
  });

  it('ignores an attempt that has fallen out of the window a number match may reach', async () => {
    const attempt = await recordAttempt({ phone: '+8801700000014' });
    // Two days old: the send trail keeps thirty days, but a report that arrives this late and
    // names no reference describes nothing this platform can still identify with confidence.
    await app.client.query(`UPDATE otp_deliveries SET createdAt = ? WHERE id = ?`, [
      new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      attempt.id
    ]);

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { number: '8801700000014', status: 'DELIVRD' },
      { headers: receiptHeaders }
    );

    expect(response.body.matched).toBe(false);
    expect(response.body.candidates).toBe(0);
    expect((await stored(attempt.id)).receiptState).toBe('UNKNOWN');
  });

  it('keeps the gateway’s second word beside its first instead of smoothing them', async () => {
    const attempt = await recordAttempt({ phone: '+8801700000015', messageId: 'BULK-9002' });
    const report = (status: string, reason?: string) =>
      postJson(
        app,
        DELIVERY_REPORT_PATH,
        {
          provider: 'bulksmsbd',
          message_id: 'BULK-9002',
          status,
          ...(reason ? { reason } : {})
        },
        { headers: receiptHeaders }
      );

    expect((await report('UNDELIVERED', 'Absent subscriber')).body.state).toBe('FAILED');
    expect((await report('DELIVRD')).body.state).toBe('DELIVERED');

    const row = await stored(attempt.id);
    expect(row.receiptState).toBe('DELIVERED');
    // A gateway that first said it failed and then said it was delivered said two things, and
    // an operator asking why a customer did not get a code wants both of them.
    expect(row.detail).toMatchObject({
      count: 2,
      statusToken: 'DELIVRD',
      previousStates: ['FAILED']
    });
  });

  it('records a report it cannot read without claiming the handset received anything', async () => {
    const attempt = await recordAttempt({ phone: '+8801700000016', messageId: 'BULK-9003' });

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { provider: 'bulksmsbd', message_id: 'BULK-9003', status: '202' },
      { headers: receiptHeaders }
    );

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(true);
    expect(response.body.state).toBe('UNKNOWN');

    const row = await stored(attempt.id);
    // Stored as unknown with the gateway's own token: the operator can see that a report
    // arrived and what it said, which is not the same as reading it as delivery.
    expect(row.receiptState).toBe('UNKNOWN');
    expect(row.detail).toMatchObject({ statusToken: '202' });
  });

  it('answers a report that describes no attempt without pretending it landed', async () => {
    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { message_id: 'BULK-NOBODY', status: 'DELIVRD' },
      { headers: receiptHeaders }
    );

    // 200 rather than an error: the gateway has done its job by reporting, and a non-2xx would
    // have it retry a report this deployment will never find a home for.
    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(false);
    expect(response.body.matchedBy).toBeNull();
    expect(response.body.deliveryId).toBeNull();
  });

  it('accepts a GET callback carrying the report in the query string', async () => {
    const attempt = await recordAttempt({ phone: '+8801700000017' });
    const query = new URLSearchParams({
      number: '8801700000017',
      status: 'DELIVRD',
      secret: SECRET
    });

    const response = await apiRequest(app, 'GET', `${DELIVERY_REPORT_PATH}?${query}`);

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(true);
    expect(response.body.deliveryId).toBe(attempt.id);
    expect((await stored(attempt.id)).receiptState).toBe('DELIVERED');
  });

  it('accepts a form-encoded body, which is the shape these gateways send in', async () => {
    const attempt = await recordAttempt({
      phone: '+8801700000018',
      messageId: 'BULK-9004'
    });

    const response = await fetch(`${app.url}${DELIVERY_REPORT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-webhook-secret': SECRET
      },
      body: new URLSearchParams({
        provider: 'bulksmsbd',
        message_id: 'BULK-9004',
        status: 'DELIVRD'
      }).toString()
    });
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.matched).toBe(true);
    expect(body.deliveryId).toBe(attempt.id);

    // The request the report arrived on is on the row, so a receipt can be followed into the
    // request log line for the same call — which is where the caller's address was recorded.
    const row = await stored(attempt.id);
    expect(row.detail?.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('takes the receipt from an OTP the platform actually sent', async () => {
    const phone = '+8801700000019';
    const attempt = await dispatch(phone);

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { number: '8801700000019', status: 'DELIVERED' },
      { headers: receiptHeaders }
    );

    expect(response.body.matched).toBe(true);
    expect(response.body.deliveryId).toBe(attempt.id);

    // The row the login path wrote now says two different things: the gateway accepted the
    // message (false in mock mode, where nothing really left) and the handset received it.
    const row = await app.client.query<{ delivered: number }>(
      `SELECT delivered FROM otp_deliveries WHERE id = ?`,
      [attempt.id]
    );
    expect(Boolean(row.rows[0].delivered)).toBe(false);
    expect((await stored(attempt.id)).receiptState).toBe('DELIVERED');
  });

  it('refuses a report that presents no secret, or the wrong one', async () => {
    const body = { message_id: 'BULK-9001', status: 'DELIVRD' };

    const missing = await postJson(app, DELIVERY_REPORT_PATH, body);
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHORIZED');

    const wrong = await postJson(app, DELIVERY_REPORT_PATH, body, {
      headers: { 'x-webhook-secret': `${SECRET}-not-quite` }
    });
    expect(wrong.status).toBe(401);

    // A public route, but not an open one: no report was written by any of the three.
    const row = await stored('otpd_fixture_1');
    expect(row.receiptState).toBe('DELIVERED');
    expect(row.detail?.count).toBe(1);
  });

  it('refuses a request that is not a delivery report at all', async () => {
    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { ping: 'are you there' },
      { headers: receiptHeaders }
    );

    // Nothing in it could ever name an attempt, so this is a caller that is not sending
    // reports — a health check or a misconfigured callback — and saying so is the fastest way
    // for whoever is wiring the gateway up to find out.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('is disabled rather than open when no secret is configured', async () => {
    const report = { message_id: 'BULK-9001', status: 'DELIVRD' };

    const posted = await postJson(unconfigured, DELIVERY_REPORT_PATH, report);
    // Not a 5xx: a gateway retrying this would spend its retry budget on a report that cannot
    // be accepted until an operator changes the configuration.
    expect(posted.status).toBe(403);
    expect(posted.body.error.code).toBe('SMS_RECEIPT_WEBHOOK_DISABLED');

    const fetched = await apiRequest(unconfigured, 'GET', `${DELIVERY_REPORT_PATH}?status=DELIVRD`);
    expect(fetched.status).toBe(403);

    // And the unmatched 403s changed nothing.
    expect((await stored('otpd_fixture_1')).detail?.count).toBe(1);
  });

  it('shows the operator the handset outcome beside the acceptance, and what it was read from', async () => {
    const phone = '+8801700000020';
    const attempt = await recordAttempt({ phone, messageId: 'BULK-9005' });
    await postJson(
      app,
      DELIVERY_REPORT_PATH,
      {
        provider: 'bulksmsbd',
        message_id: 'BULK-9005',
        status: 'UNDELIVERED',
        reason: 'Absent subscriber'
      },
      { headers: receiptHeaders }
    );

    const view = await getJson(
      app,
      `/api/v1/admin/otp-deliveries?phone=${encodeURIComponent(phone)}`,
      { token: adminToken }
    );
    expect(view.status).toBe(200);

    const delivery = view.body.deliveries.find((row: any) => row.id === attempt.id);
    expect(delivery.receipt).toMatchObject({
      state: 'FAILED',
      detail: { statusToken: 'UNDELIVERED', reason: 'Absent subscriber', matchedBy: 'messageId' }
    });
    // The acceptance is still reported as what it is, unchanged by the later report.
    expect(delivery.delivered).toBe(true);
    expect(delivery.providerStatus).toBe('202');
    expect(view.body.summary.receipt.failed).toBeGreaterThanOrEqual(1);

    // The filter is what turns the trail into a call-back list.
    const failedOnly = await getJson(
      app,
      `/api/v1/admin/otp-deliveries?phone=${encodeURIComponent(phone)}&receipt=FAILED`,
      { token: adminToken }
    );
    expect(failedOnly.body.deliveries.map((row: any) => row.id)).toEqual([attempt.id]);

    const delivered = await getJson(
      app,
      `/api/v1/admin/otp-deliveries?phone=${encodeURIComponent(phone)}&receipt=DELIVERED`,
      { token: adminToken }
    );
    expect(delivered.body.count).toBe(0);

    // Not yet reported is a state of its own, and this attempt has left it.
    const unreported = await getJson(
      app,
      `/api/v1/admin/otp-deliveries?phone=${encodeURIComponent(phone)}&receipt=UNKNOWN`,
      { token: adminToken }
    );
    expect(unreported.body.count).toBe(0);

    const nonsense = await getJson(
      app,
      `/api/v1/admin/otp-deliveries?receipt=SOMETIMES`,
      { token: adminToken }
    );
    expect(nonsense.status).toBe(400);
  });

  it('serializes the receipt for a row written before the column existed', () => {
    // Rows from an older schema read as UNKNOWN with no detail, which is exactly what
    // "nothing has been reported" means — and is distinguishable from a report that could
    // not be read only by the detail being present.
    const legacy = serializeDelivery({
      id: 'otpd_legacy',
      phone: '+8801700000099',
      provider: 'none',
      delivered: false,
      attempts: 0,
      createdAt: new Date().toISOString()
    });

    expect(legacy.receipt).toEqual({ state: 'UNKNOWN', detail: null });
  });

  it('leaves an attempt it could not match exactly as it was', async () => {
    const attempt = await recordAttempt({ phone: '+8801700000021', messageId: 'BULK-9006' });
    const before = await stored(attempt.id);

    const response = await postJson(
      app,
      DELIVERY_REPORT_PATH,
      { message_id: 'BULK-9999', status: 'DELIVRD' },
      { headers: receiptHeaders }
    );
    expect(response.body.matched).toBe(false);

    expect(await stored(attempt.id)).toEqual(before);
  });
});
