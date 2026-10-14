import {
  SmsReceiptService,
  parseSmsReceipt,
  presentedWebhookSecret,
  receiptSecretMatches
} from '../../auth/smsReceipts';
import { env } from '../../config/env';
import { AppError, UnauthorizedError, ValidationError } from '../../core/errors';
import type { OtpDeliveryRepository } from '../../db/repositories';
import type { RequestContext, Route, RouteResult } from '../httpUtils';

const API_PREFIX = '/api/v1';

/**
 * Where a gateway is told to report what happened to a message.
 *
 * Under `/api/v1` like everything else, because a gateway is configured with a full URL and a
 * version outside the path would be a second way for the same API to be addressed. Named after
 * the gateway's own vocabulary — a delivery report — rather than after this codebase's word for
 * the thing it is written onto, since the person configuring the callback is reading the
 * gateway's documentation, not ours.
 */
const DELIVERY_REPORT_PATH = `${API_PREFIX}/webhooks/sms-delivery-reports`;

export interface WebhookRouteDeps {
  otpDeliveryRepo: OtpDeliveryRepository;
  /** Overrides the configured shared secret (used by tests). */
  secret?: string;
  /** The gateway that reports no provider name is assumed to be this one. */
  provider?: string;
  /** Injectable for tests; defaults to a service over `otpDeliveryRepo`. */
  service?: SmsReceiptService;
}

/** The query string as a plain object: some gateways can only call back with a GET. */
function queryAsPayload(query: URLSearchParams): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of query) {
    payload[key] = value;
  }
  return payload;
}

/**
 * The delivery-report endpoint: the gateway's second and later word about a message.
 *
 * The OTP send is over by the time most of this arrives, so nothing here gates a login. What it
 * does is replace the platform's only claim about an SMS — that the gateway accepted it for
 * delivery — with the gateway's own report about the handset. Without it, an operator
 * investigating "I never got my code" can see that every dispatch was accepted and cannot see
 * that two of them expired at the operator, which is the difference between a customer problem
 * and a gateway problem.
 *
 * Three deliberate tolerances, because neither provider this platform sends through documents
 * a delivery-report contract:
 *
 * - GET and POST both answer, and a POST may carry JSON or a form-encoded body
 *   (`readJsonBody` parses both). Query parameters are read as well and merged under the body,
 *   so a gateway configured with nothing but a callback URL and a query template works.
 * - The shared secret is accepted in any of several headers, as a bearer token, or as a query
 *   parameter. Where it arrives is a property of the gateway's configuration form; only its
 *   value is checked, and it is checked in constant time.
 * - The payload is read for what a report must contain rather than validated against a schema:
 *   an unrecognised status word is stored as it was written, and a report that can be attached
 *   to nothing is answered `matched: false` rather than refused.
 *
 * Nothing here is public in the sense of being open: the secret is the only authentication, so
 * this is the one route whose whole access decision lives in its handler — there is no account
 * to hold a role, and the caller is a machine that cannot sign in. See the declaration in
 * tests/routeAuthorization.test.ts.
 */
export function createWebhookRoutes(deps: WebhookRouteDeps): Route[] {
  const service = deps.service ?? new SmsReceiptService(deps.otpDeliveryRepo);
  const secret = (deps.secret ?? env.SMS_RECEIPT_WEBHOOK_SECRET).trim();
  const fallbackProvider = (deps.provider ?? env.SMS_PROVIDER).trim();

  const handler = async (ctx: RequestContext): Promise<RouteResult> => {
    if (secret === '') {
      // Not a 5xx: this is a configuration the deployment chose, and telling a gateway to
      // retry would only fill its retry budget with a report that cannot be accepted yet.
      // And not a 401 either — there is no secret to be wrong about.
      throw new AppError(
        'Delivery reports are not accepted by this deployment: SMS_RECEIPT_WEBHOOK_SECRET is not configured',
        403,
        'SMS_RECEIPT_WEBHOOK_DISABLED'
      );
    }

    const presented = presentedWebhookSecret({ headers: ctx.headers, query: ctx.query });
    // One message for both "nothing presented" and "wrong secret": the refusal should not tell
    // a caller which half of the guess they got right.
    if (presented === null || !receiptSecretMatches(presented, secret)) {
      throw new UnauthorizedError(
        'The delivery-report secret must be presented in the x-webhook-secret header, as a bearer token, or as a secret query parameter'
      );
    }

    // The body wins over the query string when both are present: a POST that carries a payload
    // is the more deliberate channel than the URL the gateway was configured with.
    const receipt = parseSmsReceipt(
      { ...queryAsPayload(ctx.query), ...ctx.body },
      { fallbackProvider: fallbackProvider === '' ? null : fallbackProvider }
    );

    // A report naming neither a reference nor a number could not be attached to an attempt
    // even if one existed, so this is a caller that is not sending delivery reports at all —
    // a health check or a misconfigured callback. Answered as the malformed request it is,
    // which is the fastest way for whoever is wiring the gateway up to find out.
    if (receipt.messageId === null && receipt.phone === null) {
      throw new ValidationError(
        'A delivery report must name the message it reports on: send a message reference (messageId, sms_id, ...) or the recipient phone number'
      );
    }

    const outcome = await service.ingest(receipt, { requestId: ctx.requestId });

    // 200 even when nothing was attached. The gateway has done its job once it reported; a
    // non-2xx would have it retry a report that this deployment will never find a home for,
    // and the honest answer — this describes no attempt we have — is in the body.
    return {
      status: 200,
      body: {
        success: true,
        matched: outcome.matched,
        matchedBy: outcome.matchedBy,
        deliveryId: outcome.deliveryId,
        // How many attempts for that number could have been the one being described. 1 when the
        // report named the message itself, 0 when nothing was found.
        candidates: outcome.candidates,
        state: outcome.state,
        statusToken: outcome.statusToken,
        reason: outcome.reason,
        receipt: {
          provider: receipt.provider,
          messageId: receipt.messageId,
          phone: receipt.phone,
          fields: receipt.fields
        }
      }
    };
  };

  // Two routes, one handler: a gateway that can only issue a GET callback is common, and the
  // report is the same report either way.
  return [
    {
      method: 'GET',
      path: DELIVERY_REPORT_PATH,
      requiresAuth: false,
      handler
    },
    {
      method: 'POST',
      path: DELIVERY_REPORT_PATH,
      requiresAuth: false,
      handler
    }
  ];
}
