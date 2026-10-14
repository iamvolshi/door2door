# Cox's Bazar Delivery Platform: API Reference

Base URL: `/api/v1`
Authentication: Bearer JWT in `Authorization: Bearer <token>` header. An access token is
bound to the session that minted it, so a revoked, rotated or logged-out session refuses
its tokens on the very next request (`401`) instead of waiting for the 15-minute expiry.

> **Implemented today:** the endpoints in section 1 (phone OTP login, self-service
> registration, refresh, logout, me), section 1b (admin registration review, the OTP
> delivery trail and the security-notice operator view), section 1c (customer delivery
> addresses), section 1d (the account's own
> security notices) and section 3a (recording a
> payment, the customer cancelling an order, and an administrator refunding), `GET /health`,
> `GET /merchants/:id/menu`, `POST /orders/quote`, `POST /orders` and `GET /orders/:id`.
> Order endpoints require a customer access token. Everything else in this document is a
> design target, not a running route.
>
> Login OTPs are delivered by a real SMS gateway (`SMS_PROVIDER`: `greenweb` or
> `bulksmsbd`) with bounded retries and exponential backoff, and every send attempt is
> logged. `smsDelivered` is true only when the provider accepted the message.
>
> Phone-login state lives in the platform database (`otp_challenges`), not in process
> memory: the pending code, the 60-second resend cooldown and the failed-attempt counter
> are shared by every process using that database and survive a restart. Challenges are
> pruned opportunistically once they have been idle for 24 hours.

---

## 1. Authentication & User Management

### `POST /auth/otp/request`
Sends a 6-digit OTP to a registered Bangladeshi mobile number. The request body is just `{ "phone": "01812345678" }`; the three ways of writing one — `+8801812345678`, `8801812345678`, `01812345678`, with optional spaces or dashes — are all accepted, and anything else (including a number from another country) is `400`. The response is identical for unknown numbers (no account enumeration). The SMS is dispatched through the configured provider with retries and exponential backoff on transient failures; `smsDelivered` is true only when the provider accepted the message. When delivery is unavailable — no provider configured, `SMS_MOCK_MODE=true`, or every attempt failed — it is false and, outside production only, `devOtp` carries the code so development still works. A provider that is selected but unusable (unknown name or missing credential) fails closed with 503. Re-requesting within 60s returns 429, and that limit is enforced by the database rather than by one process, so a second process cannot issue a competing code for the same number.
- **Body**:
  ```json
  {
    "phone": "01812345678",
    "role": "customer" // optional and ignored: the role always comes from the stored account
  }
  ```
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "smsDelivered": true,
    "expiresInSeconds": 300
  }
  ```
  Outside production, a response with `"smsDelivered": false` also carries
  `"devOtp": "254667"`; a successful delivery never includes it.

### `POST /auth/otp/verify`
Verifies the submitted OTP. For an existing account it returns JWT tokens; for a number with no account it returns a **registration offer** instead, and the code stays valid so `POST /auth/register` can use it. A wrong code is rejected with 401 either way, so nobody without the code can tell the two cases apart. Verification reads the code from the database, so any process can verify a code issued by any other, and spending a code is a conditional update — the same code signs in exactly once per request however many processes are running. Three wrong guesses invalidate the code and the next one returns 429, with the count accumulated across processes.
- **Body**:
  ```json
  {
    "phone": "01812345678",
    "otp": "541298"
  }
  ```
- **Response** `200 OK`:
  ```json
  {
    "user": {
      "id": "usr_cxb_8912",
      "phone": "01812345678",
      "name": "Rahim Uddin",
      "role": "CUSTOMER",
      "isActive": true
    },
    "tokens": {
      "accessToken": "eyJhbGciOi...",
      "refreshToken": "eyJhbGciOi...",
      "expiresIn": 900,
      "tokenType": "Bearer"
    },
    "session": { "id": "sess_9f2c...", "refreshExpiresAt": "2026-10-20T13:00:00.000Z" }
  }
  ```
- **Response** `200 OK` for an unknown number:
  ```json
  { "success": true, "registrationRequired": true, "phone": "+8801811000004" }
  ```

### `POST /auth/register`
Creates a self-service account using the code just verified. Customers are usable immediately; merchants and drivers are created **PENDING** and cannot use their role permissions until an admin approves them — they can still sign in and check `/auth/me`. The code is retired by a successful call, so one verified code creates at most one account, and validation failures do not burn it. `ADMIN` cannot be self-registered.
- **Body**:
  ```json
  {
    "phone": "01812345678",
    "otp": "541298",
    "fullName": "Rahim Uddin",
    "role": "customer", // customer | merchant | driver
    "email": "rahim@example.com", // optional; a phone-number placeholder is used otherwise
    "details": {
      "businessName": "Sea Breeze Grill",
      "tradeLicenseNumber": "TRAD-9911",
      "streetAddress": "Shop 3, Beach Road",
      "area": "Kolatoli",
      "district": "Cox's Bazar"
    }
  }
  ```
  `details` is required for merchants (`businessName`, `tradeLicenseNumber`, and the shop address: `streetAddress`, `area`, `district`) and drivers (`nidNumber`, `vehicleType`), and accepts optional `zoneId`, `category`, `description`, `postalCode` (merchant) or `zoneId`, `licenseNumber` (driver). The shop address is asked for at registration because a store cannot be created without one, and the applicant is the only one who knows it; `postalCode`, when given, must be four digits. A `tradeLicenseNumber` another store already holds is refused here with `409` rather than waiting to fail at approval.
- **Response** `201 Created`:
  ```json
  {
    "success": true,
    "user": { "id": "usr_1fc5390330c34511", "role": "MERCHANT", "approvalStatus": "PENDING", "isActive": true },
    "approvalRequired": true,
    "message": "Registration received. An administrator will review this account before it can be used.",
    "tokens": { "accessToken": "eyJhbGciOi...", "refreshToken": "eyJhbGciOi...", "expiresIn": 900, "tokenType": "Bearer" },
    "session": { "id": "sess_9f2c...", "refreshExpiresAt": "2026-10-20T13:00:00.000Z" }
  }
  ```
  `approvalRequired` is `false` for customers. `409` means the phone, email or trade licence already has an account, `401` a wrong or expired code, `400` a malformed application.
  Creating the account also warns whoever holds the phone, in their own notice list (`type: PHONE_CLAIMED`), because the number now has an account on it: the OTP proved the number moments ago, but a claim that was not theirs — a forwarded message, a recycled SIM — is exactly what this is for. The warning is raised on the account-creation path, so every route that creates an account warns once.

---

## 1b. Registration review (admin)

Requires an admin access token (`registration:read` / `registration:review`; admins only).

### `GET /admin/registrations`
Lists accounts awaiting review, newest first. Query: `status` (`PENDING` default, `APPROVED`, `REJECTED`, `ALL`), `role` (`MERCHANT`, `DRIVER`), `approvable` (`true`, `false`, `ALL`), `limit` (`1`–`200`, default `100`). Returns each account with the onboarding `details` it submitted, and a `readiness` judgement on it.

`readiness` answers, before an approval is attempted, whether it would succeed as the application stands — an application can be unapprovable however complete it looks, because the platform's own state has moved since it was filed:

```json
{
  "readiness": {
    "approvable": false,
    "blockedBy": [
      {
        "code": "SHOP_ADDRESS_MISSING",
        "field": "address",
        "message": "This application has no shop address, so its store cannot be created without one.",
        "fixableByReviewer": true,
        "remedy": "Pass an `address` object in the approve body; the shop address can be taken down by phone and attached to the approval."
      }
    ]
  }
}
```

| `code` | What blocks the approval | `fixableByReviewer` |
| --- | --- | --- |
| `SHOP_ADDRESS_MISSING` | The application states no `streetAddress`/`area`/`district`, so no store can be built | yes — `address` in the approve body |
| `TRADE_LICENCE_MISSING` | The application carries no `tradeLicenseNumber` at all (a row filed before that was required) | no |
| `TRADE_LICENCE_IN_USE` | The licence now belongs to another store — filed before that one existed, or approved since | no — only a rejection resolves it |
| `NID_MISSING` | No `nidNumber`, so no rider profile can be created | yes — `rider.nidNumber` |
| `VEHICLE_MISSING` | No `vehicleType` | yes — `rider.vehicleType` |
| `VEHICLE_INVALID` | A `vehicleType` outside `BICYCLE`, `MOTORCYCLE`, `WALKER`, `EV_SCOOTER` | yes — `rider.vehicleType` |

`field` names the same field the approval itself would fail on, so the queue and the `400` say one thing rather than two. `fixableByReviewer` is `true` only where the approve body can carry the missing piece; the rest are decisions, not data entry, and their `remedy` says so. Readiness is judged per request, never stored: an account whose store already exists is approvable with no blockers, and an account can *gain* a blocker (a second store claiming its licence) without its own row changing. `approvable` is deliberately absent from the summary's inputs — see below — and `readiness` is reported for every row the filters return, including applications that need no approval at all.

- **Response** `200 OK`: `{ "count": 2, "summary": { "count": 5, "approvable": 3, "blocked": 2, "possiblyTruncated": false }, "registrations": [ … ] }`. The `summary` counts what this response assessed, over the `status` and `role` filters alone, so narrowing the list to the blocked ones does not hide the ratio beside them. `possiblyTruncated` is `true` when the status/role set filled the page exactly, which means more may match — raise `limit` or narrow by `role` before treating a worklist as complete.

`?approvable=false` is the worklist: the applications that would fail if approved right now, each with the field to fix and what to do about it.

### `POST /admin/registrations/:userId/approve`
Approves a pending merchant or rider. Approval does both halves of the job: it unlocks the role's permissions **and** creates the operational profile the role cannot work without — a `merchants` store (with the shop address it was approved on) for a merchant, and a `rider_profiles` record for a rider, holding the NID number, vehicle type, optional licence and zone from the application, with `dutyStatus` starting at `OFF_DUTY`. The two are one unit of work, so an approval that cannot build the profile is rolled back and the account stays `PENDING`.
- **Body** (optional, and both halves are optional): `{ "address": { "streetAddress": "Room 2, Sugandha Point", "area": "Sugandha", "district": "Cox's Bazar", "postalCode": "4700" } }` for an application filed before merchants had to state a shop address, and `{ "rider": { "nidNumber": "1997112233445", "vehicleType": "motorcycle", "licenseNumber": "DK-7788" } }` for a rider's identity and vehicle when the application arrived without them. Without either (and without one on the application) the call answers `400` naming the field — `address`, `details.nidNumber` or `details.vehicleType` — which is the same field the queue's `readiness` flags.
  Each `rider` field is independent: supply only what is missing, and whatever the application already carries is used unchanged. `vehicleType` is normalized the way registration normalizes it (`motorcycle` and `MOTORCYCLE` are the same answer); `nidNumber` must be 4–40 characters, and `licenseNumber` may be `null` to record that there is none. What the reviewer supplied is recorded in the audit row as field names under `suppliedByReviewer` — never the values, because an identity number does not belong in a log.
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "registration": { "userId": "usr_1fc5...", "role": "MERCHANT", "approvalStatus": "APPROVED", "reviewedBy": "usr_admin_001" },
    "profile": {
      "role": "MERCHANT",
      "merchantId": "merch_9b2c...",
      "businessName": "Sea Breeze Grill",
      "tradeLicenseNumber": "TRAD-9911",
      "category": "grocery",
      "addressId": "addr_41f0...",
      "phone": "+8801811000002",
      "isOpen": true,
      "rating": 5
    }
  }
  ```
  A rider's `profile` carries `userId`, `nidNumber`, `vehicleType`, `licenseNumber`, `zoneId` and `dutyStatus` instead. Because the store now exists, `GET /merchants/:merchantId/menu` answers for it immediately (with an empty catalogue until items are added). `409` if it is already in that state or the trade licence is held by another store, `400` for a role that is not reviewed or a profile that cannot be built, `404` if unknown.

### `POST /admin/registrations/:userId/reject`
Rejects a registration. The body requires a non-empty `reason`, which the applicant can read back from `/auth/me`. Both decisions are written to `audit_logs` as `REGISTRATION_APPROVE` / `REGISTRATION_REJECT`.
A rejection also warns the applicant in their own notice list (`type: REGISTRATION_REJECTED`, carrying their `role`, the administrator's `reason` and `reviewedBy` in `details`) and attempts the same SMS a burned session does. The reason is kept in the record and never in the wording, so the message an applicant reads names no one and asks for no reply; the administrator's words stay available to them through `/auth/me`. Approval is not a notice: it grants access rather than warning anybody about it.

### `GET /admin/otp-deliveries`
The OTP SMS attempt trail, newest first, answering "did this login's code actually go out?". Every dispatch to the gateway is recorded — accepted or not — together with a refusal that happened before any send. Requires `otp:read` (admins only).
- **Query**: `phone` (any format an operator has to hand; it is normalized, so `01711223344` and `+8801711223344` match the same attempts), `delivered` (`true`, `false` or `ALL`), `provider`, `limit` (1–200, default 50).
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "count": 1,
    "summary": { "windowHours": 24, "total": 12, "delivered": 2, "failed": 10 },
    "deliveries": [
      {
        "id": "otpd_5f1c...",
        "phone": "+8801811000004",
        "provider": "bulksmsbd",
        "delivered": true,
        "providerStatus": "202",
        "failureCode": null,
        "failureReason": null,
        "messageId": "stub-5888",
        "attempts": 1,
        "latencyMs": 15,
        "requestId": "4f2a...",
        "sentAt": "2026-10-13T16:52:01.412Z"
      }
    ]
  }
  ```
  `providerStatus` is the gateway's own token (`SENT`, `202`, `1007`, …), `attempts` is how many HTTP tries the dispatch made, and `latencyMs` is the time the accepted or final attempt took. `failureCode` is a stable machine code (`SMS_NOT_SENT` when no provider is configured, `SMS_PROVIDER_UNCONFIGURED` for a refusal, `SMS_INSUFFICIENT_BALANCE`, `SMS_HTTP_500`, …) with the gateway's wording in `failureReason`. `requestId` matches the `x-request-id` header of the login request, and `sentAt` orders the list.
  The `summary` always covers the last 24 hours and ignores the `delivered` filter, so a failure-only listing still reports how many sends succeeded. Attempts are kept for 30 days and pruned opportunistically with later logins.

---

### `POST /admin/otp-challenges/reset`
The help desk's lever on a stuck login: it lifts the resend cooldown on a phone number, and can send one code while the caller is still on the line. Requires `otp:manage` (admins only).

A customer who cannot get a code has two ways to be stuck, and both are the same number's own state: a resend is refused for 60 seconds after every send, and wrong guesses retire the code on file. Neither can be waited out on somebody else's behalf, so an operator lifts the wait — and, when the caller is on the phone, asks for the code to go out now.
**Body**:

| Field | Rules |
| :--- | :--- |
| `phone` | required, in any form the operator was given: `01711223344`, `8801711223344` and `+8801711223344` name the same challenge |
| `reason` | required — recorded on the audit row, because acting on somebody else's login is a thing an operator has to be able to justify later |
| `send` | optional boolean, default `false`. `true` also issues and sends one code now |

- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "phone": "+8801711223344",
    "cleared": { "hadChallenge": true, "cooldownSecondsRemaining": 43, "cooldownReleased": true, "attempts": 2, "lockedOut": false, "codeRetired": false },
    "challenge": { "phone": "+8801711223344", "hasChallenge": true, "attempts": 2, "maxAttempts": 3, "lockedOut": false, "codeLive": true, "expiresAt": "2026-10-13T18:05:00.000Z", "lastSentAt": "2026-10-13T17:59:20.000Z", "resendAllowedAt": null, "secondsUntilResend": 0 },
    "code": null,
    "auditLogId": "aud_9f2c..."
  }
  ```
- `cleared` says what was actually lifted. `cooldownSecondsRemaining` is how long the customer was being asked to wait when the call arrived — `0` when no wait was running — `attempts` and `lockedOut` quote the wrong guesses on file, and `codeRetired` is true only when a forced send replaced a code that still worked: the customer holding the old one will find it refused, which is a thing to say on the call.
- `challenge` is the state as it now stands. With `send: true` that is the fresh code, so `attempts` is back to `0` and a new cooldown is running — a forced code is a code like any other, and it carries the same 60-second rule.
- `code`, when a send was asked for, is the dispatch outcome: `sent`, `delivered`, `provider`, `providerStatus`, `messageId`, `attempts`, `latencyMs`, `expiresInSeconds`, and a `failure` object with the stable `code` and the gateway's wording when it did not deliver. In development only — and only when nothing was delivered — a `devOtp` carries the code itself, exactly as `POST /auth/otp/request` does, so an operator can read it out; it is never exposed in production.
- **Nothing else about the challenge moves.** The code already in the customer's hand stays valid, so lifting a wait cannot invalidate the code they are about to type, and no reset signs anybody in or grants anything. What it moves is the record's `lastSentAt`.
- **A number that never asked for a code is answered, not refused**: `cleared.hadChallenge: false` says there was nothing to lift, and `send: true` on such a number is the ordinary way to text somebody whose very first code never arrived.
- **The two halves fail together.** When a send is asked for and the platform cannot text anybody — no credential, or a provider nothing implements — the call answers `503` **before anything changes**. That is the same refusal the number's own request gets, the blocked attempt is written to the delivery trail, and no cooldown is lifted, so a desk that cannot reach the number has not moved its login state either.
- **Audited**: one `OTP_CHALLENGE_RESET` row carrying the administrator, the session they acted from, the number, what was lifted, and whether a code went out and was accepted. Neither the code nor the hash it is stored as is ever on it.

---

### `GET /admin/security-notices`
The notices the platform has issued, with what happened when it tried to warn the owner out of band — the operator's answer to "who was warned, and did it get through?". Requires `audit:read` (admins only). Read-only: the path serves no mutating verb, and nothing here can create, alter or delete a notice.

Each notice carries its own outcome (`outOfBand`), written back by the channel that attempted it:

| `outOfBand.state` | Meaning |
| --- | --- |
| `DELIVERED` | The gateway accepted the message for delivery. |
| `FAILED` | An attempt reported back and did not deliver. The `code` says why — `SMS_NOT_SENT` when no provider is configured, `SMS_CLIENT_UNAVAILABLE`, `SMS_PROVIDER_REJECTED`, … — and `reason` carries the human wording. |
| `UNKNOWN` | No attempt has reported back: the notice was stored but the process never learned the outcome. Not a failure and not a delivery — the state a hard kill leaves behind. |

- **Query Parameters**:
  - `state`: `DELIVERED` | `FAILED` | `UNKNOWN` | `ALL` (default). Anything else is a `400`.
  - `type`: one notice type, or `ALL` (default). `SESSION_REVOKED`, `REGISTRATION_REJECTED`, `ACCOUNT_SUSPENDED`, `PHONE_CLAIMED`; anything else is a `400`.
  - `followUpOnly`: `true` for the worklist — notices that reached the owner by neither channel, meaning the out-of-band attempt did not deliver *and* the owner has not read the notice in their list.
  - `lockedOutOnly`: `true` for the notices whose owner cannot sign in at all, so the list holding the warning is unreadable to them. Narrower than `followUpOnly`, and the one to start with: an unreached warning on a working account can still be read the next time its owner signs in, while on a suspended account nobody can read it until an administrator reinstates them. Combine the two (`?followUpOnly=true&lockedOutOnly=true`) for "locked out and never told".
  - `userId`: one account. `since`: a lower bound on `createdAt` (any `Date`-readable value, echoed back as ISO-8601). `limit`: `1`–`100`, default `50`.
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "count": 1,
    "summary": { "total": 12, "delivered": 9, "failed": 3, "unknown": 0, "read": 4, "followUp": 3 },
    "notices": [
      {
        "id": "ntf_4f1c9a2b8e7d6c5b4a39",
        "userId": "usr_cust_001",
        "type": "SESSION_REVOKED",
        "title": "Your session was ended for your protection",
        "body": "Your Cox's Bazar Door2Door session was ended: a sign-in token was used twice. If this wasn't you, someone has your token. Sign in again.",
        "details": { "familyId": "sess_8b21…", "reusedSessionId": "sess_8b21…" },
        "createdAt": "2026-10-13T19:41:12.884Z",
        "readAt": null,
        "read": false,
        "outOfBand": {
          "state": "FAILED",
          "channel": "SMS",
          "provider": "none",
          "delivered": false,
          "code": "SMS_NOT_SENT",
          "reason": "SMS provider is not configured",
          "providerStatus": null,
          "messageId": null,
          "attempts": 0,
          "latencyMs": null,
          "attemptedAt": "2026-10-13T19:41:12.901Z"
        },
        "followUp": true,
        "lockedOut": true,
        "customer": { "id": "usr_cust_001", "fullName": "Rumana Akter", "phone": "+8801715550091", "role": "CUSTOMER", "isActive": false, "approvalStatus": "APPROVED" }
      }
    ]
  }
  ```
  `followUp` is derived, not stored: `true` only while `outOfBand.state` is not `DELIVERED` and `readAt` is `null`. A notice the owner has acknowledged has reached them — on the list, if not by text — so it leaves the queue without the outcome being rewritten, which is why a row can read `state: FAILED` and `followUp: false` at once. Under `UNKNOWN`, `outOfBand` carries the state alone.
  `lockedOut` is derived in the same way, from the account rather than the notice: it is `true` while `customer.isActive` is `false`, which is the state in which phone login and token rotation both refuse the account, so nothing on the in-app list can be read by its owner. It is not stored, because an account can be suspended and reinstated long after the notice was written — reinstating moves the notices out of the priority worklist without altering a single one. A rejected or pending applicant is **not** locked out: the review gate closes role permissions, not the account, so those owners can still sign in and read what they were told. `customer.isActive` and `customer.approvalStatus` are reported beside it so the reason is visible without a second lookup.

  The customer is joined in because "follow up" needs somebody to contact; the phone is shown as stored, the same as in the OTP trail above. `customer.isActive` is `null` only if the account behind a notice cannot be read at all, in which case `lockedOut` is reported `false` rather than guessed. The `summary` covers every notice the `userId` and `since` filters admit and deliberately ignores `state`, `followUpOnly` and `lockedOutOnly`: "none delivered" is only meaningful beside "twelve failed", so filtering the ratio would defeat it — and the locked-out filter is not even answerable from the notices alone, since it reads the joined account. Narrowing the worklist therefore never changes the numbers reported beside it.

---

## 1c. Customer delivery addresses

Requires a customer access token holding `address:manage:own`. A registered customer can
save, edit and remove their own delivery addresses, which is what makes an order possible
for an account that was not seeded. Every statement carries the token owner's id, so an
address belonging to somebody else is reported as `404` rather than `403` — a guessable id
never confirms that another customer's address exists.

### `GET /addresses`
Lists the customer's addresses, default first then newest. An address that has been taken off
the list is not one of them: it appears in no listing, answers no id, and does not count
against the cap, however many orders still name it.
- **Response** `200 OK`: `{ "success": true, "count": 1, "defaultAddressId": "addr_…", "addresses": [ … ] }`

### `POST /addresses`
Saves one. The first address a customer saves becomes their default automatically; a later
one becomes the default only when `isDefault` is true, and the previous default is cleared.
At most 10 addresses per customer (`409` beyond that).
- **Body**:
  ```json
  {
    "label": "Home",
    "streetAddress": "House 12, Road 3, Kolatoli",
    "area": "Kolatoli",
    "district": "Cox's Bazar",
    "postalCode": "4700",
    "latitude": 21.4258,
    "longitude": 91.9723,
    "isDefault": true
  }
  ```
  `label` defaults to `Home`. `streetAddress` (3–200), `area` and `district` are required;
  `postalCode` must be 4 digits; `latitude`/`longitude` must be supplied together and in
  range. Anything else is `400` with the offending field in `error.details.field`.
- **Coordinates have to be somewhere the fleet goes.** A pair that is given is checked against
  the pilot's service areas (`src/services/serviceAreaRules.ts` → `ServiceAreaManager`) and a
  point in no zone, or in one that is `INACTIVE`, is a `400`:
  ```json
  {
    "success": false,
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "Delivery to (23.8103, 90.4125) is outside every serviced area. Registered zones: Cox's Bazar Sadar, Ramu, …",
      "details": {
        "field": "latitude", "latitude": 23.8103, "longitude": 90.4125,
        "serviceArea": null, "reason": "Location is outside the registered Cox's Bazar coverage zones."
      }
    }
  }
  ```
  `serviceArea` is the zone code the point landed in, or `null` when it landed in none, so a
  client can tell "we do not go there" from "that zone is suspended this week". A `RESTRICTED`
  zone (Saint Martin's Island) is **accepted** — the platform serves it through its maritime
  courier window — and a point just outside a bounding box but within the manager's own 25 km
  fallback radius is accepted too, because that fallback is the coverage rule rather than an
  accident of it. The check runs before the insert, so a refused address leaves no row and does
  not take the default off the address it would have replaced.
- **Coordinates are optional**, and an address saved without them is not judged: the gate reads
  coordinates, and one they are absent from is one it cannot read. `PATCH` likewise judges only
  a pair the request itself supplies, so an address saved earlier keeps its coordinates until
  somebody moves it.
- **Response** `201 Created`: `{ "success": true, "address": { … } }`

### `PATCH /addresses/:addressId`
Updates the fields given and nothing else; `{ "isDefault": true }` promotes the address and
demotes the previous default. An empty body is `400`. A `latitude`/`longitude` pair in the
body is checked against the service areas exactly as `POST` checks one, and a refused move
leaves the row where it was — the address is judged as a destination, not as an edit.

### `DELETE /addresses/:addressId`
Takes the address off the customer's list. If it was the default, the newest remaining
address takes over and the response carries the promotion as `defaultAddressId`.

An address an order was delivered to cannot be deleted — the order names it, and that
delivery's history has to keep resolving — so that row is **detached** instead: gone from
`GET /addresses`, `404` to `GET` and `PATCH` and unusable as an order's destination, and kept
on file only as the address those orders say they were sent to. Nothing is lost by the
customer: every order carries its own copy of where it went (see `GET /orders/:orderId`), so
the delivery history does not depend on the row staying on their list.

The response says which of the two happened:
- **`200 OK`**: `{ "success": true, "deletedAddressId": "addr_cust_004", "outcome": "DETACHED", "ordersKeepingIt": 2, "defaultAddressId": "addr_cust_001" }`
- `outcome` is `DELETED` — the row is gone, `ordersKeepingIt` is `0` — or `DETACHED`, meaning
  orders still name it. Either way the address is no longer one of the customer's, so it also
  stops counting against the ten an account may keep.

### `GET /addresses/:addressId`
One of the customer's own addresses, or `404` — which is also the answer for an address they
have taken off their list, whether or not orders still name it.

---

### `POST /auth/refresh`
Exchanges a refresh token for a new pair. Refresh tokens are single-use: rotation retires the presented token and issues its successor inside the same **session family**, the chain opened by one login. Reusing a spent token is treated as theft — the whole family is revoked, so the token issued by that rotation stops working too and only a fresh login restores access. Sessions from other logins are left alone.
- **Body**: `{ "refreshToken": "<token>" }`
- **Body → response**: `200 OK` with a new token pair, or `401`:
  ```json
  {
    "success": false,
    "error": {
      "code": "REFRESH_TOKEN_REUSE",
      "message": "This refresh token was already used, so every session for that login has been revoked",
      "details": { "revokedSessions": 1 }
    }
  }
  ```
  `revokedSessions` counts the live sessions the detection retired (`0` when the attempt replayed a chain that was already burned). Every detection is logged and written to `audit_logs` as `REFRESH_TOKEN_REUSE_DETECTED`, naming the family it was attributed to. Two concurrent refreshes of the same token cannot both succeed: one wins and the family is then burned, so the loser's attempt never mints a session.

The account holder is told, because a family burn signs them out of the device they are holding — a warning they never receive looks exactly like the platform breaking. The warning is written first into the account's own notice list, and only then attempted as an SMS to the number they sign in with: *"Your Cox's Bazar Door2Door session was ended: a sign-in token was used twice. If this wasn't you, someone has your token. Sign in again."* The list is the channel that cannot fail for want of a handset, a provider or a budget: the row is committed before this `401` is answered, so a client that never receives the text still finds the warning the next time it signs in (see section 1d). The SMS goes out through the same provider as login codes and off the request path, so the `401` never waits on a gateway (measured at 11 ms against a gateway that took 700 ms). The durable write costs one local insert: the reuse path measures 2.55 ms per replay without it and 3.87 ms with it, over 400 replays. A notice that cannot be delivered never changes the security outcome, and the SMS attempt's own outcome is written to `audit_logs` as `SECURITY_NOTICE_SENT` or `SECURITY_NOTICE_FAILED`, carrying the provider, its status token, the message id and a stable failure code (`SMS_NOT_SENT` when no provider is configured, `SMS_CLIENT_UNAVAILABLE`, …), while the notice row stands as the record that the owner can still be warned. A notice still in flight when the process stops is finished before shutdown completes; a notice lost to a hard kill is now only the SMS, because the durable half is already committed.

Revocation reaches access tokens too, immediately. Every token names the session that minted it, and a bearer request is only accepted while that session is live, so burning a family, rotating a link or logging out retires the access tokens it issued there and then (`401` "This session was revoked; sign in again") rather than leaving them usable until their own 15-minute expiry. The cost is one primary-key lookup per authenticated request (measured at 0.016 ms against the SQLite store), paid on the request path so no route can forget it. A token that names no session — anything minted before sessions were bound — is refused with `401` "Access token is not bound to a session; sign in again" instead of being trusted, which is why a deployment of this change asks clients to sign in once more.

### `POST /auth/logout`
Revokes the session behind a refresh token. Idempotent: `revoked` is `true` only when this call retired a live session. The access token that session issued stops working on the next request as well.
- **Body**: `{ "refreshToken": "<token>" }`

### `GET /auth/me`
Returns the authenticated account. Requires `Authorization: Bearer <accessToken>`.

### `GET /auth/sessions`
Every session the caller still holds, newest first — what a person means by "my devices". No permission: the rows are the caller's own, narrowed by the token's user id, and an account still awaiting review must be able to read them.
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "count": 2,
    "currentSessionId": "sess_9f2c1d0a7b3e4f5a6c81",
    "sessions": [
      {
        "id": "sess_9f2c1d0a7b3e4f5a6c81",
        "isCurrent": true,
        "familyId": "sess_9f2c1d0a7b3e4f5a6c81",
        "ipAddress": "203.0.113.7",
        "userAgent": "Mozilla/5.0 (Linux; Android 14)",
        "createdAt": "2026-10-13T18:20:00.000Z",
        "expiresAt": "2026-10-20T18:20:00.000Z"
      }
    ]
  }
  ```
- **One entry per login, not per rotation**: a refresh retires the row it replaces and opens its successor, so a chain of refreshes is one device however many times the token has been exchanged. A session whose refresh token has run out is not listed either — nobody is holding it — though its row stays for the audit trail.
- **The refresh-token digest is never part of this answer.** The columns are named explicitly rather than `SELECT *`, and the row type (`AuthSessionView`) has no field to put a digest in, so "the session list leaked the credential" is a compile error instead of a review catch.
- `ipAddress` is the address the login came from, as recorded for that session; it is `[redacted]` once past `PII_RETENTION_DAYS`. `isCurrent` marks the session this request came through, so a client does not have to guess which entry is the phone in its hand.

### `DELETE /auth/sessions/:sessionId`
Ends **one** of the caller's own sessions — the device the account no longer trusts, leaving the one it is holding signed in. `sessionId` is an `id` from the listing above.
- **Response** `200 OK`: `{ "success": true, "revokedSessionId": "sess_…", "currentSessionRevoked": false, "message": "That session has been ended. This one is still signed in." }`
- **`currentSessionRevoked`** says whether the device that asked was the device it named. Naming your own session is allowed and ends it: the reply says so ("Sign in again to continue") rather than leaving the client to discover it on its next call.
- **The ended session is out at once**, on both of its tokens: its access token is refused because the session behind it is gone, and its refresh token cannot mint a new one. Every other session of the account is untouched, which is the point of the route.
- **Naming a session that is not the caller's own live one is `404`, and everything that is not gets the same answer**: another account's session, an id that names nothing, one this account already ended, and one whose refresh token has expired. Telling those apart would make a session id worth guessing, so they are one `NOT_FOUND` with one message — the caller cannot even learn that an id is real.
- **The scoping is in the `UPDATE`**, not in a read before it: `WHERE id = ? AND userId = ? AND isRevoked = 0 AND expiresAt > ?`, so nothing can move between a check and a write, and the liveness test is the same one the listing uses.
- Recorded in `audit_logs` as `SESSION_REVOKED`, in the same transaction as the revocation. Two sessions are named on that row: `entityId` is the session that was ended, and `sessionId` is the login the request came through — a different row whenever the owner ended a device other than the one in their hand. An attempt that ended nothing writes no row.
- No permission, for the same reason as the listing and the button below: the rows are the caller's own, and an account still awaiting review holds no grant yet may hold a handset it no longer trusts.

### `POST /auth/sessions/revoke-all`
The account owner's own panic button: a phone left in a taxi, a shared laptop, a token that may have been read over a shoulder. Ends **every** session the account holds.
- **Body**: none.
- **Response** `200 OK`: `{ "success": true, "revokedSessions": 3, "currentSessionRevoked": true, "message": "Every session for this account has been ended, including this one. Sign in again to continue." }`
- **`currentSessionRevoked` is the point of the reply**: nothing is kept alive, this request's own session included, so the client learns it has been signed out here rather than discovering it on its next request. The access token that asked, the other devices' access tokens, and every refresh token the account holds are all refused with `401` from the next call onward.
- **`revokedSessions` counts live sessions, not rows**: an expired row the owner was no longer signed in on is retired but not counted, so the number is the number of devices that were actually cut off. The listing above and this count come from the same query.
- **The read and the write share one transaction**, so a login racing this call is either ended or left alone, never half-counted.
- **Another account is untouched** — this ends one account's sessions, not the platform's — and the sessions of an account still awaiting review are equally endable, which is why the route carries no permission.
- Recorded in `audit_logs` as `SESSIONS_REVOKED_ALL`, with the session ids it retired.
- A security notice is deliberately **not** raised: a notice exists to tell the owner about something they probably did not do, and waking their phone to confirm a button they just pressed would train them to ignore the channel that matters.

### Which session did what
Every request that proves which session it belongs to records that session id on the rows it writes, so the trail answers the second question an incident asks. `audit_logs.userId` says which account acted; `audit_logs.sessionId` says which of that account's logins it was — the customer's own handset or the one somebody else is holding. The column is written by everything the request goes on to do: order placement, a merchant's profile edit and catalogue changes, payment and cancellation rows, an administrator's approval, suspension or reinstatement, and the session ends itself (`SESSIONS_REVOKED_ALL`, and the session a replayed refresh token belonged to on `REFRESH_TOKEN_REUSE_DETECTED`).

```sql
-- Everything one login did, across the whole platform.
SELECT createdAt, action, entityType, entityId FROM audit_logs WHERE sessionId = 'sess_9f2c…' ORDER BY createdAt;
```

The column is indexed (`idx_audit_logs_session`), because that is the query it exists for. It is `NULL` where there was no session to name, and that is not backfilled: a request authorised by something other than a bearer token has no login behind it, so registration, login, refresh and logout write nothing rather than a guess. `NULL` therefore means "no session was involved", which is different from "the session is unknown". The id is an opaque platform identifier rather than personal data, so the PII retention sweep leaves it alone: after the window has closed the row keeps its content and loses the address and device string beside it.

One gap is deliberate. A security notice's own delivery row (`SECURITY_NOTICE_SENT` / `SECURITY_NOTICE_FAILED`) is written by the channel that carried the warning, not by the request that caused it, and is raised on paths with no session at all — registration is the common one. The row that records the *decision* (the suspension, the approval, the reuse detection) carries the session; the row that records the text message does not.

### Mobile client contract
The primary client is a native mobile app, so this is the behaviour it is written against. Nothing here is a separate endpoint — it is how the routes above are meant to be driven from a handset.

- **Token storage.** The access token (15 minutes) may live in memory. The refresh token (7 days) is a credential: Keychain on iOS, Keystore on Android — never `AsyncStorage`, `SharedPreferences`, or any file backup channel. A leaked refresh token burns at most one session family: the first replay revokes the whole chain, and `POST /auth/sessions/revoke-all` is the "log out everywhere" button when the owner notices.
- **One refresh in flight.** Concurrent `POST /auth/refresh` calls with the same token cannot both succeed: one wins and the loser's token is spent, which the server reads as theft and burns the family. Serialise refreshes behind a single lock (or a shared promise) so a burst of 401s on access-token expiry does not sign the user out.
- **Reading a 401 on refresh.** `code` decides, not the status:
  - `REFRESH_TOKEN_REUSE` — the chain is burned (theft *or* a double-refresh race the client lost). Wipe both tokens, stop retrying, and send the user through OTP login again. The server has already written the warning into their notice list and attempted the SMS, so the next sign-in shows it.
  - `UNAUTHORIZED` ("Session has expired", "no longer valid") — the refresh token simply died. Same UX minus the warning: wipe and re-login, no retry.
  - Never loop on a 401 from this route: every attempt with a spent token re-fires the reuse path and its SMS.
- **Backing off on 429.** Every rate-limit refusal carries the wait twice: `error.details.retryAfterSeconds` in the body and the standard `Retry-After` response header in the same whole seconds. Honour the header (the OS networking stack can do it without parsing JSON). This covers both the per-address budget and the per-number OTP resend cooldown (`POST /auth/otp/request` answers 429 with `retryAfterSeconds` while the 60-second cooldown runs — arm the "resend code" timer from it instead of guessing).
- **OTP entry.** A code is 6 digits, valid 5 minutes, and retires after 3 wrong guesses — the 4th wrong attempt invalidates it and the right code stops working too, so after `Too many failed attempts` the only path is a fresh code. Verifying the same code twice never mints two sessions: logins consume the code, and registration consumes it again, so a double-tap on "confirm" is safe.
- **Pending and suspended accounts.** A merchant or rider awaiting review gets `403 ACCOUNT_NOT_APPROVED` on every permission-bearing route but can still use `/auth/me`, `/auth/sessions`, and the session ends — the app should show a waiting state, not a login screen. A suspended account's tokens die at once (suspension revokes sessions in the same transaction), so a 401 right after a suspension notice means "signed out", not "token bug".

---

## 1d. Security notices (in-app)

The account's own warnings, readable after signing in. This is the second channel a security notice travels on; the first is SMS, which needs a provider, a budget and a handset, and none of the three is guaranteed. A notice is written here first — before the response that triggered it leaves the process — so a warning still lands when the SMS could not be sent at all.

| Field | Meaning |
| --- | --- |
| `type` | Stable vocabulary for what happened. `SESSION_REVOKED` (a spent refresh token was replayed), `REGISTRATION_REJECTED` (an administrator refused an application), `ACCOUNT_SUSPENDED` (an account was deactivated), `PHONE_CLAIMED` (an account was created for this number). |
| `title` / `body` | What to show the owner. The body is the same wording the SMS carries, so the two channels cannot drift apart. |
| `details` | The incident the notice belongs to, or `null`: the session ids for a burn, the `role` for a refusal, a suspension or a claim, plus the administrator's `reason` and `reviewedBy` where a human made the decision. Recorded, never rendered. |
| `read` / `readAt` | Whether the owner has acknowledged it, and when. |

### `GET /notifications`
The caller's own notices, newest first. Requires `Authorization: Bearer <accessToken>`.
- **Query Parameters**:
  - `limit`: `1`–`100`, default `20`. Anything else is a `400` rather than a silently smaller answer.
  - `unreadOnly`: `true` for just the notices that have not been acknowledged yet.
- **Response** `200 OK`: `{ "count": 1, "unreadCount": 1, "notifications": [ … ] }`. `unreadCount` is every unread notice on the account, not only the ones on this page.
- Every query is keyed to the token owner: another account's notices are not merely absent from the response, they are never selected. An account still awaiting review may read its own notices — a burned session does not wait for an administrator. A **suspended** account is the one exception, and by necessity: it cannot hold a session at all, so its notices — including the one explaining the suspension — are read after an administrator reinstates it.

### `POST /notifications/read`
Acknowledges the caller's notices.
- **Body**: `{ "ids": ["ntf_…"] }` for particular notices, or `{}` for everything outstanding. `ids: []` is a `400`, because "none" and "all" must not look the same, and ids that belong to somebody else change nothing.
- **Response** `200 OK`: `{ "markedRead": 1, "unreadCount": 0 }`. `markedRead` counts the rows this call actually changed, so a second call reports `0` instead of claiming the work twice. Reading does not delete: the notice stays in the list with `read: true`.

```json
{
  "success": true,
  "count": 1,
  "unreadCount": 1,
  "notifications": [
    {
      "id": "ntf_4f1c9a2b8e7d6c5b4a39",
      "type": "SESSION_REVOKED",
      "title": "Your session was ended for your protection",
      "body": "Your Cox's Bazar Door2Door session was ended: a sign-in token was used twice. If this wasn't you, someone has your token. Sign in again.",
      "details": { "familyId": "sess_8b21…", "reusedSessionId": "sess_8b21…" },
      "createdAt": "2026-10-13T19:41:12.884Z",
      "readAt": null,
      "read": false
    }
  ]
}
```

---

## 1e. Account status (admin)

Requires an admin access token holding `system:manage` (admins only). Each call is one
transaction: an account that is deactivated without its sessions retired would keep working
for the remaining minutes of its access token, and sessions retired without the deactivation
would let it sign straight back in.

### `POST /admin/users/:userId/suspend`
Ends an account's access immediately: it can no longer sign in, the sessions it holds are
retired there and then, and its owner is warned why.
- **Body**: `{ "reason": "Chargeback fraud reported by two merchants" }` — required,
trimmed, kept to 500 characters.
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "account": { "id": "usr_1fc5…", "role": "CUSTOMER", "isActive": false },
    "revokedSessions": 2
  }
  ```
  `revokedSessions` is how many live sessions this call retired — an operator asking "is it
off right now?" is answered with devices signed out, not with a flag written.
- The owner is then warned the same way a burned session warns them, on both channels: a row
in their own notice list (`type: ACCOUNT_SUSPENDED`, with `role`, the administrator's
`reason` and `suspendedBy` in `details`) and an SMS attempt. The list entry is written while
the account is locked out on purpose — reinstatement is what makes it readable.
- `400` for a missing reason, the caller's own account, or any administrator account (which
is provisioned rather than self-served, and which no second administrator could undo); `404`
unknown; `409` already suspended. Audited as `ACCOUNT_SUSPENDED`.

### `POST /admin/users/:userId/reinstate`
Restores an account, so a suspension is not a one-way door. No body; the response is the same
shape with `isActive: true` and `revokedSessions` always `0` — the sessions retired at
suspension stay retired. The owner signs in again, which is both the proof that they still
hold the phone and where they find the notice explaining what happened. Audited as
`ACCOUNT_REINSTATED`; `400`/`404` as above, `409` if the account is not suspended.

---

## 2. Customer & Store Discovery

### `GET /merchants`
List nearby merchants filtered by pilot zones and categories.
- **Query Parameters**:
  - `zone`: `kolatoli` | `laboni` | `sugandha` | `hotel_zone` | `all`
  - `category`: `restaurant` | `grocery` | `pharmacy` | `dry_fish_souvenir`
  - `lat`: float (e.g., `21.4172`)
  - `lng`: float (e.g., `91.9858`)
- **Response** `200 OK`:
  ```json
  [
    {
      "id": "mer_jhawbon_01",
      "name": "Jhawbon Restaurant",
      "nameBn": "ঝাউবন রেস্টুরেন্ট",
      "zone": "laboni",
      "rating": 4.7,
      "cuisine": ["Traditional Seafood", "Bengali"],
      "isOpen": true,
      "estimatedPrepTime": 25,
      "deliveryFeeBdt": 45
    }
  ]
  ```

### `GET /merchants/:id/menu`
Get menu items and customization options for a given merchant.

---

## 3. Order Lifecycle & Pricing

### `POST /orders/quote`
Calculates delivery fee, service charge, taxes, discounts, and estimated delivery duration before checkout.
- **Body**:
  ```json
  {
    "merchantId": "mer_jhawbon_01",
    "items": [{ "itemId": "item_rupchanda_fry", "quantity": 2 }],
    "dropoffLocation": { "lat": 21.418, "lng": 91.982, "address": "Hotel Sea Crown, Room 402, Kolatoli" },
    "couponCode": "COXFIRST50"
  }
  ```
- **Response** `200 OK`:
  ```json
  {
    "subtotalBdt": 900,
    "discountBdt": 50,
    "deliveryFeeBdt": 40,
    "serviceFeeBdt": 15,
    "totalBdt": 905,
    "estimatedDeliveryMinutes": 35
  }
  ```

### `POST /orders`
Places a confirmed order. Requires `order:create`, an `Idempotency-Key` header, and a
delivery address: `deliveryAddressId` names one of the customer's own addresses, or may be
omitted entirely once the customer has a default (the first address they save), in which
case the default is used. Naming an address that belongs to somebody else is `403`; having
no address at all is `400` with `error.details.field` set to `deliveryAddressId`.

**Retrying is safe, and stays safe across restarts.** The key, the claim on it and the
response are rows in `idempotency_keys`, not process memory, so the same key returns the
already-placed order — same `order.id`, `201`, no second order — after a crash, a deploy or
from another process on the same database. The stored key is namespaced with the account
and the endpoint, so two customers may use the same `Idempotency-Key` value without seeing
each other's order, and one client's key can never be answered with another's response.

The claim on the key, the order itself and the stored answer are written in **one
transaction**. That is what makes the retry safe in the awkward cases as well as the easy
one: a process killed mid-order, an answer that cannot be written, a connection lost — the
whole thing rolls back, so the retry finds no key and places the order exactly once,
rather than finding a key whose order already exists and placing it again. When two
requests carrying the same key overlap, the second is answered with either that same order
(if the first has finished) or `409 CONFLICT` (if it is still running). A key sent with a
*different* payload is `409` too, because the stored answer belongs to the first request.

The key is held for **1 hour**; after that the same value is free to be used again — for a
different order as much as a retry — so retries should stay well inside that window.

**Where it went is recorded on the order, not only pointed at.** At placement the order keeps
its own copy of the delivery address — label, street, area, district, postcode and coordinates
— so an address corrected afterwards, or taken off the customer's list, can neither rewrite nor
erase what an order says about its own delivery. The order still carries
`deliveryAddressId` for the row itself. Placing above an address that has been taken off the
list is `404`, like any other address that is not on the customer's list.

### `GET /orders/:orderId`
One order with its lines. Readable by the customer it was placed for, by the owner of the store
it was placed with, or by a role holding `order:read:all`; a caller outside those answers
`403`.

The response carries `deliveryAddressId` plus `deliveryAddress` — where the order was sent, as
it stood at placement: `label`, `streetAddress`, `area`, `district`, `postalCode`, `latitude`,
`longitude`. It is reported to the customer the order was delivered to and to a role holding
`pii:read:full`; the store selling the order reads the sale without the customer's door.

The recorded address is preferred over the row the id names, which is what makes it a record:
an address edited or retired afterwards reports as it was then, and an order placed before the
platform kept its own copy falls back to the row as it stands today.

---

## 3a. Payments, refunds and order cancellation

Three routes move money. All three require an `Idempotency-Key` header and are guarded by
the same durable idempotency service as `POST /orders`, for the same reason: a retry (a
dropped connection, a deploy, a second instance) must not take or return money twice.
Nothing here calls a payment gateway — there is none in this codebase, and a guarded action
has to be a database write that can be rolled back with its transaction. The platform keeps
the record: `payments` for money taken, `refunds` for money given back.

### `POST /orders/:orderId/payments`
Records a completed payment against the customer's own order. Requires `order:create`.
- **Body**: `{ "method": "BKASH" | "NAGAD" | "CREDIT_CARD" | "CASH_ON_DELIVERY", "reference": "TXN-123" }`
  (`reference` is optional and stored with the payment).
- **Amount**: the order's own `totalBdt`. An `amountBdt` in the body is ignored — a client
  that could name the amount could pay one taka for a delivered meal.
- **Responses**: `201` with `payment` (id, transactionId, amountBdt, status, reference),
  `403` if the order belongs to somebody else, `404` unknown order, `409` when the order is
  cancelled or **has already been paid**, `400` on an unknown `method` or a missing key.
- **Twice cannot happen**: at most one payment per order may reach `COMPLETED`, enforced by
a partial unique index as well as by the handler, so two different keys asking to charge the
same order cannot both succeed.

### `POST /orders/:orderId/cancel`
The customer ends their own order. Requires `order:cancel:own` **and** ownership — an
administrator holding the permission is refused here, because ending somebody else's order
is a different decision. Refunded amount follows the cancellation policy:

| Order state when cancelled | What the customer gets back |
| :--- | :--- |
| `PENDING` (within the 2-minute grace period, or before merchant acceptance) | 100% |
| `CONFIRMED` / `PREPARING` | everything except half the items subtotal (the merchant's food cost) |
| `OUT_FOR_DELIVERY` | refused — `403` with the policy reason |
| `DELIVERED` | refused; an administrator uses the refund endpoint |

- **Body**: `{ "reason": "Changed my mind" }` (optional).
- **Responses**: `200` with the order's new status, `refundAmount`, the policy that was
  applied (`policy.reason`, `policy.refundEligibilityPercent`) and the `refund` row when one
  was written; `409` if the order is already cancelled; `403` as above.
- **An unpaid order is cancelled with no refund row**: only money that actually arrived can
  go back, so a cash order cancelled before delivery writes the cancellation and nothing else.
- **The refund is capped by what was paid**, and the payment is only marked `REFUNDED` when
  all of it went back; a partial refund leaves the payment `COMPLETED`.

### `POST /orders/:orderId/refunds`
Sends money back after the cancellation window has closed, or after delivery. Requires
`order:manage:all` (administrator only).
- **Body**: `{ "amountBdt": 250, "reason": "Missing item" }` — `amountBdt` is optional and
defaults to everything still held.
- **Responses**: `201` with the `refund` row plus `paidAmountBdt` and
  `previouslyRefundedBdt`; `409` when nothing was ever paid or when the order has already
  been refunded in full; `400` when the amount exceeds what is still held.
- **Refunds are summed, not limited to one.** Partial refunds may follow each other until
  the money taken is returned, and no further.

### What makes a retry safe here
A repeat of the same request (**same key**) is answered from the stored answer: same
`payment.id` or `refund.id`, same status, no second row. A **different key** asking for the
same money is refused by the write transaction, which reads what has already been taken and
returned inside the same `BEGIN IMMEDIATE` that writes the new row — so the two cannot both
see "nothing paid yet" or "nothing refunded yet", however they interleave across processes.
That is the difference between a retry (answered) and a duplicate (refused), and it is what
makes a double charge or a double refund impossible rather than merely unlikely.

---

## 4. Delivery Driver Operations & WebSocket Protocol

### `GET /drivers/me/duty`
The signed-in rider's own duty state. Requires `rider:duty:own` — the rider's own grant, which administrators hold as well; an administrator has no rider profile and answers `404`.
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "duty": {
      "userId": "usr_driv_001",
      "dutyStatus": "AVAILABLE",
      "meaning": "On duty and ready to be given work.",
      "available": true,
      "vehicleType": "MOTORCYCLE",
      "zoneId": "kolatoli",
      "updatedAt": "2026-10-13T18:02:11.402Z",
      "settable": ["AVAILABLE", "ON_BREAK", "OFF_DUTY"]
    }
  }
  ```
  `meaning` and `settable` are served rather than left to a client to hardcode, so a rider's screen and the platform cannot describe the same state differently.

### `PATCH /drivers/me/duty`
Puts the rider on or off the roster. Requires `rider:duty:own`.
- **Body**: `{ "status": "AVAILABLE" }` — one of the three states a rider owns, case-insensitive:

| `status` | Means | Consequence |
| :--- | :--- | :--- |
| `AVAILABLE` | on duty and ready for work | on the roster, `available: true` |
| `ON_BREAK` | on duty but not taking new work | on the roster, `available: false` |
| `OFF_DUTY` | not working | off the roster |

- **Response** `200 OK`: `{ "success": true, "changed": true, "duty": { … } }`. `changed` is `false` when the rider asked for the state they were already in: that is **answered, not refused**, because a client retrying "go available" on a flaky connection is not making an error. The duty change itself is logged; it is deliberately not an `audit_logs` row — see `docs/LIMITATIONS_AND_ROADMAP.md`.
- `ON_DELIVERY` is **not** settable here (`400`): it is what dispatch sets while an order is in the rider's hands. `ON_DUTY` is not a value either — the platform's word for it is `AVAILABLE`, and the `400` says so rather than leaving a caller to infer it.
- `409` while the rider is already `ON_DELIVERY`: a rider carrying a delivery stays on the roster until it is handed over or dispatch takes it back. The guard is part of the write (`WHERE dutyStatus <> 'ON_DELIVERY'`), so an assignment landing mid-request cannot be raced by a rider going off duty at that instant.
- `404` when the account has no rider profile — approval is what creates one, so this is "approved but no record", never "not a rider". `403 ACCOUNT_NOT_APPROVED` while the account is still under review, so a pending rider cannot put themselves on the roster before an administrator approves them.

### `GET /drivers/roster`
Who is on duty, so dispatch has somebody to hand work to. Requires `rider:read:all` (administrators). Read-only: nothing here changes a rider's state.
- **Query**: `zoneId` (the rider's zone label, exact match), `dutyStatus` (`AVAILABLE`, `ON_DELIVERY`, `ON_BREAK`, `OFF_DUTY`, `ALL`), `limit` (`1`–`200`, default `200`). Anything else is a `400`.
- With no `dutyStatus`, the answer is the **working roster**: everybody not `OFF_DUTY`. `ALL` adds the riders who are off duty, and naming one state narrows to it. "Off duty" is a value rather than a separate flag because "who is off duty" and "who is on duty" are one question with two answers.
- **Response** `200 OK`: `{ "success": true, "count": 2, "query": { "zoneId": null, "dutyStatus": null, "includeOffDuty": false }, "riders": [ … ] }`, each rider carrying `userId`, `fullName`, `phone`, `vehicleType`, `zoneId`, `dutyStatus`, `meaning`, `available` and `since` (when the state last changed — the closest thing to "on duty since" until shifts are a history of their own). The `query` is echoed back because "nobody is available" and "everybody is off duty and was not asked for" differ only by what the caller asked for.
- **Ordered by who can be given work first** — `AVAILABLE`, then `ON_DELIVERY`, `ON_BREAK`, `OFF_DUTY`, alphabetically within a state — so the head of the list is the answer to "who do I call?".
- **Identity documents are not in it**: no `nidNumber`, no `licenseNumber`. The roster exists to hand out work, not to verify who somebody is.
- **A suspended rider is not on it, in any state**: an account the platform has closed cannot be sent anywhere, and the suspension notice tells its owner why. The profile row is untouched, so reinstating returns the rider with the duty state they had.

### `GET /drivers/me/orders`
The deliveries assigned to the signed-in rider, newest first — what the duty state above is *for*. Requires `order:read:driver`, the rider grant (administrators hold it too and read an empty list, having no deliveries of their own).
- **Query**: `status` (one of the schema's states: `PENDING`, `CONFIRMED`, `PREPARING`, `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED` — case-insensitive), `limit` (`1`–`200`, default `100`). Anything else is a `400` naming the field; a state the platform does not have is refused rather than answered with an empty list.
- Ownership is the query, not a check before it: the driver id comes from the access token and is the only `WHERE` on the only statement, so there is no id in the path to guess. An order nobody has accepted, or one assigned to another rider, is not hidden from the answer — it is not in it.
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "count": 1,
    "query": { "status": "CONFIRMED", "limit": 100 },
    "orders": [
      {
        "id": "ord_001",
        "orderNumber": "CXB-2025-0001",
        "status": "CONFIRMED",
        "merchant": { "id": "merch_store_001", "businessName": "Cox's Seafood & BBQ Express" },
        "deliveryAddress": {
          "id": "addr_cust_001",
          "label": "Home",
          "streetAddress": "Flat 4B, Sugandha View, Hotel Motel Zone",
          "area": "Sugandha",
          "city": "Cox's Bazar",
          "latitude": 21.4258,
          "longitude": 91.9723,
          "deliveryInstructions": "Please include extra lime and chutney."
        },
        "totalBdt": 1460,
        "deliveryFeeBdt": 60,
        "createdAt": "2026-10-13T18:00:00.000Z",
        "updatedAt": "2026-10-13T18:00:00.000Z"
      }
    ]
  }
  ```
- **The address is not assembled here.** It goes through `maskAddress` (`src/auth/pii.ts`) — the platform's one rule for who may read a client's door — with the viewer's role and the fact that the order is assigned to them, which is the branch that rule already defines as full. So the rider reads the street they are delivering to; the day that branch changes, this route changes with it, because the rule is asked rather than reimplemented.
- **The customer's account id is not in the payload at all**: the masking rule is never handed one, so it cannot serve one. The rider is told which door and which store, and not who the customer is. `customerId` is likewise not a field here.
- **The customer's note travels inside the address**, as its `deliveryInstructions` (`orders.specialInstructions`): it is about reaching the door, so it is visible for exactly as long as the door is, and a masked address can never leak a note standing beside it.
- `deliveryAddress` is `null` only if the address row it points at has gone, which the foreign key makes unreachable. A row is reported with a null address rather than dropped from the list, because a delivery missing from a rider's list reads as "not yours".
- `403` for a customer or merchant token (naming `order:read:driver`), `401` with no token, and `403 ACCOUNT_NOT_APPROVED` while the account is still under review — a pending rider holds no grant yet.

### WebSocket Connection: `ws://api.cxbexpress.com/ws/driver` (not implemented)
Nothing in the current server serves this path: it is the protocol the dispatch work is being designed against, and the endpoints above are the implemented half of a rider's working day.
- **Handshake Headers**: `Authorization: Bearer <driver_jwt>`

#### Events:
1. **`DRIVER_LOCATION_UPDATE`** (Client -> Server):
   ```json
   {
     "event": "location_update",
     "data": { "lat": 21.4192, "lng": 91.9845, "heading": 180, "speedKmh": 22 }
   }
   ```
2. **`ORDER_OFFER`** (Server -> Driver):
   ```json
   {
     "event": "order_offer",
     "data": {
       "orderId": "ord_89211",
       "pickup": { "name": "Poushee Restaurant", "lat": 21.428, "lng": 91.979 },
       "dropoff": { "name": "Sayeman Beach Resort", "lat": 21.415, "lng": 91.983 },
       "estimatedEarningsBdt": 65,
       "expiresInSeconds": 45
     }
   }
   ```
3. **`ACCEPT_OFFER`** (Driver -> Server):
   ```json
   {
     "event": "accept_offer",
     "data": { "orderId": "ord_89211" }
   }
   ```

---

## 5. Merchant Portal APIs

The merchant's own store, without an administrator in the loop. The three routes here require
`merchant:manage:own` (the merchant's own grant, which administrators also hold but have no
store to use it on, answering `404`). The store is found by the account that owns it rather
than by an id in the path, so there is nothing to guess and nothing to authorise beyond being
the owner. Approval builds the store from the onboarding answers; `POST` exists for the one
case approval cannot produce — an approved merchant with no store to read or edit.

### `POST /merchant/profile`
Opens the caller's store, for an approved merchant that has none. Approval creates the store in
the same transaction that approves the account, so "approved with no store" is a state this API
cannot reach on its own — but a database, a migration or a restored backup can, and until now
the read and the edit both answered `404` to it with nowhere to go next. This is that way out.
- **Body**:
  ```json
  {
    "businessName": "Kolatoli Kitchen",
    "tradeLicenseNumber": "TRAD-CXB-2026-4471",
    "category": "Restaurant",
    "description": "Coastal grill and cold drinks.",
    "isOpen": true,
    "address": {
      "streetAddress": "Plot 7, Kolatoli Beach Road",
      "area": "Kolatoli",
      "district": "Cox's Bazar",
      "postalCode": "4700"
    }
  }
  ```
  `businessName` (2–160), `tradeLicenseNumber` (1–160, unique platform-wide) and `address` are
  required. The address is parsed by exactly the rules an approval's shop address goes through
  (`streetAddress`, `area`, `district` required; `postalCode` and `latitude`/`longitude`
  optional), so the two ways a shop address can enter the platform cannot disagree.
  `category` defaults to `General` and `isOpen` to `true`, the way approval defaults them, so a
  store opened here and one built by an approval are the same store as far as everything
  downstream knows.
- **Response** `201 Created`: `{ "success": true, "merchant": { … } }` in the shape `GET`
  serves, `editable` included, so the client can go straight on to editing it.
- **The store is created for the caller.** `ownerUserId` is the token owner and is never read
  from the body, so there is no id to point at somebody else's shop; the store's `phone` is the
  number the account signs in with, because a store whose phone was settable could point
  delivery at a stranger. `id`, `merchantId`, `ownerUserId`, `phone`, `rating`, `address.label`
  and `address.isDefault` are refused by name with `400` rather than ignored.
- **The licence is required here and refused by `PATCH`.** The two are not in conflict: a store
  cannot exist without one and the applicant is the only person who knows it — which is why
  registration asks for it and checks it is unique — while *changing* which licence a store
  trades under is a licensing decision. Stating it once, at birth, is what registration does.
- **`409`** when the account already has a store (the message names it, so the client edits that
  one) or when another store already holds the licence number.
- **One transaction**: the store, the shop address it points at (labelled `Shop`, with
  `isPiiRestricted: false` — a shop is a public place) and the `MERCHANT_PROFILE_CREATE` audit
  row are written together, so a refused store is never an orphaned address row either.
- `403 ACCOUNT_NOT_APPROVED` while the account is still under review: opening a store is an
  approved merchant's act. A customer or rider is refused by the permission before the handler
  runs.

### `GET /merchant/profile`
The store the caller owns, with its shop address and what of it can be changed.
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "merchant": {
      "id": "merch_store_001",
      "businessName": "Cox's Seafood & BBQ Express",
      "description": "Fresh Bay of Bengal seafood and traditional grill",
      "category": "Restaurant",
      "isOpen": true,
      "tradeLicenseNumber": "TRAD-CXB-2024-9981",
      "phone": "+8801811000002",
      "rating": 4.8,
      "addressId": "addr_merch_001",
      "address": { "id": "addr_merch_001", "label": "Main Restaurant", "streetAddress": "Plot 14, Kolatoli Beach Road", "area": "Kolatoli", "district": "Cox's Bazar", "postalCode": "4700", "isPiiRestricted": false },
      "editable": ["businessName", "description", "category", "isOpen", "address"],
      "createdAt": "2026-10-13T09:00:00.000Z",
      "updatedAt": "2026-10-13T18:20:00.000Z"
    }
  }
  ```
  The read-only fields are served rather than hidden — a merchant has to be able to see the licence it trades under and the rating it has earned — and `editable` names exactly what a `PATCH` will accept, so a client does not have to discover the boundary by being refused.

### `PATCH /merchant/profile`
Edits the shopfront. **Body**: any of

| Field | Rules |
| :--- | :--- |
| `businessName` | 2–160 characters, whitespace collapsed |
| `description` | up to 500 characters, or `null` to clear it |
| `category` | 1–160 characters |
| `isOpen` | boolean — `false` stops the platform taking orders for the store |
| `address` | `streetAddress` (3–200), `area` (1–80), `district` (1–80), `postalCode` (4 digits, may be cleared), and `latitude`/`longitude` together |

- **Response** `200 OK`: `{ "success": true, "changed": ["businessName", "isOpen"], "merchant": { … } }`. `changed` lists the fields this request actually moved, so a client that sent a whole form learns which parts of it were already true; an edit that changes nothing answers `changed: []`.
- **The shop address is edited in place**, never replaced: `addressId` stays the row the store, its orders and its riders already point at, so a shop that moves does not orphan the deliveries that named the old place. It keeps the platform's `label`.
- **`isOpen` is not decorative**: placing or quoting an order for a closed store answers `400`, which is what makes this the merchant's own switch for closing for the day.
- **Refused by name (`400`), not ignored**: `tradeLicenseNumber` (a licensing decision, unique platform-wide — an administrator's), `phone` (the number the account signs in with), `rating` (the customers' to give), `id`/`merchantId`/`ownerUserId`, `address.label` (how the platform recognises the shop) and `address.isDefault`. `address.streetAddress`, `area` and `district` may be changed but not emptied — a shop address has to stay somewhere a rider can be sent.
- **One transaction**: the profile and its address move together, so a store that says it moved while its address row still points at the old place cannot be produced. Every change is written to `audit_logs` as `MERCHANT_PROFILE_UPDATE`, with the profile before and after (a shop is a public place, so its address belongs in the record — "where was this store when the order was placed?" is answerable from it), the list of fields changed, and the request's address.
- `404` when the caller owns no store — approval is what creates one, so this is "approved with no store", never "not a merchant"; `POST` on this same path is how that merchant opens one. An account still awaiting review is refused by the review gate with `403 ACCOUNT_NOT_APPROVED` before the handler runs.

### `GET /merchant/catalog`
The store's own menu, including the items that are not on sale today — the rows a merchant opens this list to find are exactly the ones no customer can order.
- **Permission**: `catalog:manage:merchant` (a merchant's own grant; administrators hold it too and have no store to use it on, answering `404`).
- **Response** `200 OK`:
  ```json
  {
    "success": true,
    "count": 2,
    "store": { "id": "merch_store_001", "businessName": "Cox's Seafood & BBQ Express", "isOpen": true },
    "items": [
      {
        "id": "cat_9f2c1d0a7b3e4f5a6c81",
        "merchantId": "merch_store_001",
        "name": "Chittagong Mezban Beef",
        "description": "Slow-cooked beef in the Mezban style",
        "category": "Restaurant",
        "priceBdt": 320.5,
        "isAvailable": true,
        "sku": "CXB-4A91C0F27D",
        "imageUrl": null,
        "editable": ["name", "description", "category", "priceBdt", "isAvailable", "imageUrl"]
      }
    ]
  }
  ```
  Items are listed by name, case-insensitively, so the merchant's list and the public storefront show the same order.

### `POST /merchant/catalog`
Adds an item to the caller's own catalogue — the step that turns a newly approved, empty store into one that can take an order.

| Field | Rules |
| :--- | :--- |
| `name` | required, 2–160 characters |
| `priceBdt` | required, greater than 0, at most `1,000,000`, at most 2 decimal places |
| `description` | optional, up to 500 characters |
| `category` | optional; defaults to the store's own category |
| `isAvailable` | optional boolean, `true` by default |
| `imageUrl` | optional `http(s)` URL, up to 500 characters |

- **Response** `201 Created`: `{ "success": true, "item": { … } }`.
- **Prices are refused, not rounded**: `12.345` answers `400` rather than charging `12.35` — money is rounded to poisha everywhere else, and a merchant told a price the customer will not pay has been told something untrue. `0` and negative prices are refused because an order line costs something; a giveaway is a coupon.
- **`imageUrl` must be `http(s)`**: the value is fetched by other people's browsers, so `javascript:` or a bare string is refused.
- **The platform owns the id and the SKU**, and both are refused by name if sent. The item id is what orders and audit rows point at; `sku` is `UNIQUE` across every store, so a self-service one would let the first store to claim a string keep every other store out of it. A generated SKU (`CXB-…`) is issued instead.
- `409 CONFLICT` at `200` items per store, which bounds the unpaginated menu response.

### `GET /merchant/catalog/:itemId`
One of the caller's own items. An item belonging to another store answers `404`, not `403`, so item ids cannot be used to discover what somebody else sells.

### `PATCH /merchant/catalog/:itemId`
Edits the item's own fields — `name`, `description` (or `null` to clear it), `category`, `priceBdt`, `isAvailable`, `imageUrl` (or `null`).
- **Response** `200 OK`: `{ "success": true, "changed": ["priceBdt"], "item": { … } }`. An edit that changes nothing answers `changed: []`; an edit with nothing to change at all is a `400`.
- **`isAvailable` is the merchant's sold-out switch**: the item stays on this list and leaves the orderable menu — quoting or placing an order for it answers `400` "currently out of stock".
- **Refused by name (`400`)**: `id`, `itemId`, `merchantId` (the store comes from the token), `sku`, and `createdAt`/`updatedAt`.
- Every accepted change is one `CATALOG_ITEM_UPDATE` row in `audit_logs` with the item before and after and the fields that moved.

### `DELETE /merchant/catalog/:itemId`
Removes one of the caller's own items.
- **Response** `200 OK`: `{ "success": true, "deletedItemId": "cat_…" }`, with a `CATALOG_ITEM_DELETE` audit row carrying the item that was removed.
- **An item a customer has already ordered is refused with `409`**, naming the alternative: the order line keeps pointing at what was bought, so the row cannot go. Marking it unavailable is what leaves the menu without rewriting history.

### `PATCH /merchant/orders/:id/status` (not implemented)
Documented here as the merchant's order-side counterpart; nothing in the current server serves
it, and order status is still driven by the delivery and admin paths.

---

## 6. Admin & Settlement APIs

### `POST /admin/settlements/reconcile`
Reconcile daily COD collected by TomTom and bicycle drivers against merchant payables and platform take-rate.

### `GET /admin/analytics/overview`
Get real-time GMV, active drivers, unassigned orders, and pilot zone order heatmaps.

---

## 7. Request limits and client identity

Every route except `/health` allows `RATE_LIMIT_MAX` requests (default 100) per client
address per `RATE_LIMIT_WINDOW_MS` (default 60 s), and answers the next one with `429` and
`error.details.retryAfterSeconds`. The budget is counted once for the deployment, in the
database, so a second process does not double it — and the counter is keyed by a digest of
the client address, not the address itself. The window is fixed and anchored to the first
request that opened it, and a request that is refused still counts towards it, so the row
records the requests seen rather than the ones allowed. If the counter cannot be read, the
request is allowed and the failure is logged: the limit is the one control that fails open.

The address a request is counted and audited against is the socket address, unless the
request arrives from a reverse proxy named in `TRUST_PROXY` — then a forwarded header is
read, walking from the proxy inwards, and the rightmost hop that is not itself a trusted
proxy is the client. Anything to the left of it is a claim by the caller and is discarded,
so the header cannot be used to name yourself or to reset a limit. With `TRUST_PROXY`
empty (the default) no forwarded header is read at all, which is correct for a directly
exposed API and wrong behind a proxy: every client would then share one bucket and every
session row would name the proxy. Set `TRUST_PROXY=loopback` for a proxy on the same host,
or list the proxies (`loopback,10.0.0.0/8,2001:db8::/32`).

`TRUSTED_FORWARD_HEADER` names the header those proxies maintain: `x-forwarded-for` (the
default), `forwarded` for RFC 7239's `Forwarded` — whose `for`, `proto` and `host`
parameters are read, with `proto` and `host` reported from the element that named the
client — or `both`, which reads either one and, when both are present and name *different*
clients, believes neither and attributes the request to the proxy. A hop that discloses no
address — an obfuscated identifier (`for=_hidden`), `unknown`, or an element that repeats a
parameter and so cannot be read whole — stops the walk rather than being read past, and
the address falls back to the proxy; the API logs that once, because every client of such a
proxy then shares one bucket. `Forwarded` is never read unless the deployment says its
proxies maintain it.

The counter row also names the session the client was using. The count has to happen before
anything proves who is asking — an unauthenticated flood is refused before it can cost a token
check — so the session is written onto the row once the bearer token has been checked, and only
when the row is not already attributed to that session. In the ordinary case that is one write
per device per window rather than one per request: measured against the pilot store, the
counter statement costs **0.632 ms** without the session column and **0.646 ms** with it
(5,000 counted requests on a hot row), and the attribution write costs **0.016 ms** — a
single-row update with no `RETURNING`, guarded by the window, so a counter that has just
rolled over is never stamped with the device that was using it. When a window rolls over the
name goes with it: the row in place is the current window's, and a new window belongs to
nobody until somebody is counted in it.

The row stays keyed by a digest of the address rather than the address itself, and the limit
stays one budget per address, because that is what a limit can bound — a client cannot buy a
second allowance by signing in again. The session id beside the count is what keeps a client
being throttled from being an anonymous one to an operator reading the table.

That address is also the one thing here that expires. It is recorded on the login session,
and beside administrative decisions and SMS attempts; after `PII_RETENTION_DAYS` (90 by
default) those records keep their content but the address and device string are replaced
with `[redacted]`. A session that is still live is left untouched, and no endpoint reports
a redacted address as one — treat the marker as absent. The account's phone number is not
covered by the window: it is the identity the account is built on, not session metadata.
