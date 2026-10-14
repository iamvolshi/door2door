# Cox's Bazar Hyperlocal Delivery Platform 🌊🛵

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)]() 
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)]() 
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()

An end-to-end, multi-service hyperlocal delivery platform engineered specifically for the unique operational ecosystem of **Cox's Bazar, Bangladesh** — supporting Food Delivery, Groceries, Medicine & Pharmacy, Express Parcels, and Dry Fish (Shukti) / Souvenirs across Kolatoli, Laboni, Sugandha, and Marine Drive hotel corridors.

---

## 🌟 Core Highlights & Architectural Features

- **Multilingual & Localized**: Full Bengali (বাংলা) & English localization for interfaces, receipts, and SMS notifications.
- **Hyperlocal Dispatch Engine**: Supports both motorized TomTom (electric tricycles) and bicycle couriers with zone-aware batching.
- **Bangladesh MFS Ready**: Direct integrations for **bKash Tokenized Checkout**, **Nagad Merchant Gateway**, and automated **Cash on Delivery (COD)** cash-limit reconciliation.
- **Zero Map API Cost**: OpenStreetMap & OSRM routing optimized for low-bandwidth cellular environments.
- **Full Modular Monolith / Microservice Architecture**: Written in TypeScript with clean domain separation between Customer, Merchant, Driver, Dispatcher, and Admin settlement engines.

---

## 📚 Comprehensive Documentation Directory

| Document | Description |
| :--- | :--- |
| 🚀 [**Deployment Guide**](docs/DEPLOYMENT.md) | System requirements, PostgreSQL/SQLite setup, Docker, PM2, and NGINX SSL config. |
| 📡 [**API Reference**](docs/API.md) | REST endpoints, authentication, and real-time WebSocket driver dispatch specifications. |
| 💳 [**Payment Configuration**](docs/PAYMENT_CONFIG.md) | bKash tokenized flow, Nagad RSA keys, and Driver COD reconciliation rules. |
| 💰 [**Third-Party Costs**](docs/THIRD_PARTY_COSTS.md) | SMS rates, payment gateway charges, hosting costs, and MVP monthly budget. |
| 🗺️ [**Launch Strategy**](docs/LAUNCH_STRATEGY.md) | 6-phase rollout plan for Kolatoli, Laboni, Sugandha, and Sea Beach hotel zones. |
| 🛣️ [**Roadmap & Limitations**](docs/LIMITATIONS_AND_ROADMAP.md) | Current constraints, technical roadmap, and developer onboarding instructions. |

---

## ⚡ Quick Start (Local Development)

### 1. Prerequisites
- Node.js >=22.5.0 (matches `engines` in package.json)
- PostgreSQL 14+ (or built-in SQLite)
- npm v9+

### 2. Installation & Setup
```bash
# Clone the repository
git clone https://github.com/cxb-express/cxb-delivery-platform.git
cd cxb-delivery-platform

# Install dependencies
npm install

# Copy sample environment configuration
cp .env.example .env

# Compile TypeScript to dist/
npm run build

# Start the API (persistent SQLite database, migrations + pilot seed on first boot)
# Configure PORT / HOST / SQLITE_STORAGE_PATH in .env as needed.
npm start

# Seed an existing database explicitly (idempotent: skips when users already exist)
npm run db:seed
```

The API listens on `http://localhost:4000` (override with `PORT`). Configuration is read
from the real environment first, then from `.env` in the working directory (`npm start`).
By default it is backed by a persistent SQLite file at `SQLITE_STORAGE_PATH` (default
`./data/cxb_delivery.sqlite`), so orders survive restarts.

`DB_DRIVER` chooses the storage engine, and the choice is explicit rather than inferred:
`sqlite` (the default, one file on one host, shared by every process on it) or `postgres`
(a server, for several hosts or a scheduler that moves processes), which reads
`DATABASE_URL` and holds `PG_POOL_MAX` connections open. The schema is created and migrated
by the API on boot either way, and `npm run db:seed` fills whichever engine is configured,
so a misconfiguration cannot seed one database while the server reads another. The boot log
names the backend and where the data actually is — never the connection string, which carries
the password — because a deployment pointed at the wrong database looks healthy throughout.
Both engines run the same suite: `tests/postgresBackend.test.ts` starts a real PostgreSQL,
creates its own schema, and holds the session lookup to one indexed read (see
[item 8](docs/LIMITATIONS_AND_ROADMAP.md) for what each engine guarantees and how the
writer serialisation `BEGIN IMMEDIATE` provided is preserved).

Behind a reverse proxy, set `TRUST_PROXY` to the proxies that append to the forwarded
header — `loopback` for a proxy on the same host, or a list such as
`loopback,10.0.0.0/8,2001:db8::/32` — and `TRUSTED_FORWARD_HEADER` to the header they
maintain: `x-forwarded-for` (the default), `forwarded` for RFC 7239's header, or `both`.
`Forwarded` is read in full, including `proto` and `host` and obfuscated identifiers, and
with `both` a disagreement between the two headers is not resolved in the caller's favour
— the request is attributed to the proxy instead. Then each customer is rate limited on
their own address and session rows record the customer rather than the proxy. Left empty, the
default, the header is ignored entirely: the socket address is used, which is right for a
directly exposed API. A value that does not parse stops the boot, and a request from a
local peer carrying a forwarded header that the configuration does not trust is logged
once per process as a warning, so an unconfigured proxy is visible rather than silent.

Whatever address that resolves to is not kept forever. A sweep that runs with the next
login, and once at boot, replaces the address and the device string on records whose
window has closed — `PII_RETENTION_DAYS`, 90 days by default — with `[redacted]`. The rows
stay: a session is still evidence that a login happened, an audit entry still says what
was decided, an SMS attempt still says what the gateway answered. A session that is still
live keeps its address, and a row that never had one is left alone. `0` is refused, since
a privacy control that silently does nothing is worse than one that complains.

### 3. Signing up and logging in (phone + OTP)

Login is passwordless. The OTP is hashed and stored in the database (`otp_challenges`),
as are the resend cooldown and the failed-attempt counter — so a pending code outlives a
restart, any process can verify a code another process issued, and two processes cannot
both send a code to one number. The message goes out through a real SMS gateway —
Greenweb (`SMS_PROVIDER=greenweb`) or BulkSMSBD (`SMS_PROVIDER=bulksmsbd`). Send attempts
are retried with exponential backoff on transient errors (network failure, timeout, HTTP
5xx/429, or the gateway's own "internal error" code) and never retried on a permanent
rejection (bad number, unpaid balance, disabled sender ID). Every attempt is logged with
the provider's answer and a masked phone number.

The default setup (`SMS_PROVIDER=none` or `SMS_MOCK_MODE=true`) sends nothing: the API
returns the code as `devOtp` outside production and reports `smsDelivered: false`, so it
never claims a message was sent when it was not. Point it at a provider with a credential
in `.env` (`GREENWEB_API_TOKEN` / `BULKSMSBD_API_KEY` plus the matching `*_API_URL`) to send
for real; a provider that is selected without a credential fails closed with 503.

Every dispatch is recorded in `otp_deliveries` — the provider, whether it accepted the
message, the gateway's own status token, its message id, how many HTTP attempts were made,
the latency, and a stable failure code when it did not go out. So when a customer says the
code never arrived, an admin can read it back instead of guessing:

```bash
curl "http://localhost:4000/api/v1/admin/otp-deliveries?phone=01711223344" \
  -H "authorization: Bearer $ADMIN_TOKEN"
# -> { "count": 1, "summary": { "windowHours": 24, "total": 12, "delivered": 2, "failed": 10 },
#      "deliveries": [ { "provider": "bulksmsbd", "delivered": true, "providerStatus": "202",
#                         "messageId": "stub-5888", "attempts": 1, "latencyMs": 15, ... } ] }
```

Attempts are kept for 30 days.

And when the customer calls because the code never arrived, an admin can do more than read
about it: `POST /admin/otp-challenges/reset` (`otp:manage`) lifts the 60-second resend
cooldown on the number — and, with `send: true`, issues and sends one code while the caller is
still on the line, using the same gateway and the same delivery trail as the customer's own
request. It lifts the wait and nothing else: the code already in the customer's hand stays
valid, so a reset cannot invalidate what they are about to type, and no reset signs anybody
in. A number whose very first code never arrived is answered the same way rather than refused
(`cleared.hadChallenge: false` — there was nothing to lift). `cleared.cooldownSecondsRemaining`
says how long the customer was being asked to wait, `cleared.codeRetired` says whether a code
that still worked was replaced, and every call writes one `OTP_CHALLENGE_RESET` audit row
naming the administrator, the number, what was lifted and whether a gateway took a code.

```bash
curl -X POST http://localhost:4000/api/v1/admin/otp-challenges/reset \
  -H 'content-type: application/json' -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "phone": "01711223344", "reason": "caller says no code arrived", "send": true }'
# -> { "cleared": { "cooldownSecondsRemaining": 43, "codeRetired": true, ... },
#      "challenge": { "secondsUntilResend": 60, ... },
#      "code": { "sent": true, "delivered": true, "provider": "bulksmsbd", ... },
#      "auditLogId": "aud_9f2c..." }
```

Security warnings do not depend on that channel. When refresh-token reuse ends a session,
the account holder is warned twice. First in their own notice list, written before the `401`
is answered — a family burn signs them out of the device that would have received the text,
so the warning has to be somewhere a sign-in finds it. Then by SMS through the provider
configured above, at the number on the account. With no provider configured (or
`SMS_MOCK_MODE=true`) nothing is sent, and `audit_logs` records `SECURITY_NOTICE_FAILED`
with `code: SMS_NOT_SENT` rather than implying the owner was reached — while the warning is
still in the list their next sign-in reaches.

The same two channels carry the other events worth a warning, so any of them lands even
when the text cannot: an account created for a phone number (`PHONE_CLAIMED` — the OTP
proved the number, but a forwarded message or a recycled SIM is exactly what this
surfaces), an administrator refusing an application (`REGISTRATION_REJECTED`, with the
reason recorded and never texted), a burned session (`SESSION_REVOKED`), and an account
suspended by an administrator (`ACCOUNT_SUSPENDED`, written while the account is locked out,
so the owner reads it after reinstatement). The wording of each lives in one place, and
the administrator's own words stay in the record rather than the message.

An operator can see which of those warnings actually got through, and follow up on the ones
that did not:

```bash
# Every notice with its delivery outcome, newest first. followUpOnly=true is the worklist:
# the out-of-band attempt did not deliver and the owner has not read the notice either.
curl "http://localhost:4000/api/v1/admin/security-notices?followUpOnly=true" \
  -H "authorization: Bearer $ADMIN_TOKEN"
# -> { "count": 1,
#      "summary": { "total": 12, "delivered": 9, "failed": 3, "unknown": 0, "read": 4, "followUp": 1 },
#      "notices": [ { "type": "SESSION_REVOKED", "followUp": true, "lockedOut": false,
#                     "outOfBand": { "state": "FAILED", "channel": "SMS", "provider": "none",
#                                    "code": "SMS_NOT_SENT", "reason": "SMS provider is not configured" },
#                     "customer": { "fullName": "Rumana Akter", "phone": "+8801715550091",
#                                   "isActive": true, "approvalStatus": "APPROVED" } } ] }
# state=DELIVERED|FAILED|UNKNOWN narrows it; UNKNOWN means no attempt ever reported back.
# The view is read-only: it serves GET only, and requires audit:read.

# The queue an operator actually has to work: owners who are locked out — suspended, so nobody
# can sign in and read the list — and were never reached by text either. An unreached warning
# on a working account can wait for its owner's next sign-in; this one cannot. The summary is
# over the whole set either way, so narrowing the list never hides the ratio.
curl "http://localhost:4000/api/v1/admin/security-notices?followUpOnly=true&lockedOutOnly=true" \
  -H "authorization: Bearer $ADMIN_TOKEN"
# -> { "count": 1, "summary": { ... "followUp": 3 },
#      "notices": [ { "type": "ACCOUNT_SUSPENDED", "followUp": true, "lockedOut": true,
#                     "customer": { "isActive": false, "phone": "+8801715550091" } } ] }
# lockedOut comes from the account, not the notice: reinstating moves the row out of this list
# without changing anything about the warning, which is still unreached and now readable.
```

```bash
# 1. Request a code (60s resend cooldown per number, stored in the database so it
#    outlives a restart and is shared by every process; requests are also per-IP limited)
curl -X POST http://localhost:4000/api/v1/auth/otp/request \
  -H 'content-type: application/json' -d '{ "phone": "+8801811000004" }'
# -> { "success": true, "expiresInSeconds": 300, "smsDelivered": true }
# With no provider (or mock mode) this is instead:
# -> { "success": true, "expiresInSeconds": 300, "smsDelivered": false, "devOtp": "123456" }

# 2. Exchange it for a 15-minute access token and a 7-day refresh token
curl -X POST http://localhost:4000/api/v1/auth/otp/verify \
  -H 'content-type: application/json' \
  -d '{ "phone": "+8801811000004", "otp": "123456" }'
# An unknown number instead gets the offer:
# -> { "success": true, "registrationRequired": true, "phone": "+8801712000111" }

# 2b. Register with the same code (seeded accounts can skip this step)
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{ "phone": "+8801712000111", "otp": "123456", "fullName": "Farhana Yesmin",
        "role": "customer" }'
# A customer is usable at once. Merchants and drivers are created PENDING:
# -> { "success": true, "approvalRequired": true, "user": { "approvalStatus": "PENDING" }, "tokens": {...} }
# Merchants also send details.businessName + details.tradeLicenseNumber + where the shop is
# (details.streetAddress, details.area, details.district); drivers send details.nidNumber +
# details.vehicleType (BICYCLE | MOTORCYCLE | WALKER | EV_SCOOTER).

# 3. Refresh rotates the session (the previous refresh token stops working)
# Each login opens a session family. Replaying a spent refresh token is read as theft:
# the whole family is revoked (401 REFRESH_TOKEN_REUSE) and the account signs in again.
# The account holder is warned that their session was ended. The durable half is a row in
# their own notice list (GET /api/v1/notifications), committed before the 401 is answered;
# the SMS is attempted after it, so the response never waits on a gateway. The attempt is
# audited as SECURITY_NOTICE_SENT or SECURITY_NOTICE_FAILED.
# Revocation is immediate: an access token names the session that minted it and dies with
# it, so a burn, a rotation or a logout retires its access tokens on the next request
# rather than leaving them usable for their remaining 15 minutes.
curl -X POST http://localhost:4000/api/v1/auth/refresh \
  -H 'content-type: application/json' -d '{ "refreshToken": "<token>" }'

# 4. Log out revokes the session (and the access token it issued, immediately)
curl -X POST http://localhost:4000/api/v1/auth/logout \
  -H 'content-type: application/json' -d '{ "refreshToken": "<token>" }'

export TOKEN="<accessToken from step 2 or 2b>"
curl http://localhost:4000/api/v1/auth/me -H "authorization: Bearer $TOKEN"

# Where am I signed in? One entry per login, newest first — a refresh rotates the token
# inside a family, so a chain of refreshes is still one device. The refresh-token digest is
# not among the columns served, and isCurrent marks the session this request came through.
curl http://localhost:4000/api/v1/auth/sessions -H "authorization: Bearer $TOKEN"
# -> { "count": 2, "currentSessionId": "sess_...",
#      "sessions": [ { "id": "sess_...", "isCurrent": true, "ipAddress": "203.0.113.7",
#                      "userAgent": "Mozilla/5.0 …", "createdAt": "…", "expiresAt": "…" } ] }

# That one phone, and not the laptop you are working on: end a single session from the list.
# Anything that is not one of your own live sessions — somebody else's, an id that names
# nothing, one you already ended — answers the same 404, so a session id is never worth
# guessing. Recorded as SESSION_REVOKED, naming both the session ended and the one that asked.
curl -X DELETE http://localhost:4000/api/v1/auth/sessions/sess_... \
  -H "authorization: Bearer $TOKEN"
# -> { "revokedSessionId": "sess_...", "currentSessionRevoked": false,
#      "message": "That session has been ended. This one is still signed in." }

# The panic button: a phone left in a taxi, a shared laptop. Ends every session the account
# holds, this one included, so the next request with this token is refused. revokedSessions
# counts the sessions that were live, not rows — an expired one is retired but not counted.
# Recorded as SESSIONS_REVOKED_ALL. No permission is needed and none is checked: these are the
# caller's own sessions, and an account still awaiting review can end its own too.
curl -X POST http://localhost:4000/api/v1/auth/sessions/revoke-all \
  -H "authorization: Bearer $TOKEN"
# -> { "revokedSessions": 2, "currentSessionRevoked": true,
#      "message": "Every session for this account has been ended, including this one." }
```

That id is also how the trail is read. Every request that proved which session it belongs to
writes the id onto the rows it produces — `audit_logs.sessionId`, indexed — and names it on the
rate-limit row that is counting that client, so "which account did this" and "which of its
logins did this" are both answerable. `NULL` means no session was involved (registration,
login, refresh, logout), never "unknown": the column is not backfilled, and the PII retention
sweep leaves the id alone because it is an opaque handle rather than personal data.

```bash
# Everything one login did, straight from the trail
sqlite3 data/cxb_delivery.sqlite \
  "SELECT createdAt, action, entityType, entityId FROM audit_logs WHERE sessionId = 'sess_...' ORDER BY createdAt"

# Which login was behind a client that is being throttled
sqlite3 data/cxb_delivery.sqlite \
  "SELECT key, hits, windowStart, sessionId FROM request_rate_limits"
# The key is still a digest of the client address — the limit is one budget per address, and
# the session id beside it is the name, written once per device per window rather than per
# request. When a window rolls over the name goes with it.

# The same two queries on the PostgreSQL backend (the column names keep the spelling they
# have in code, which is why they are quoted here and why the driver quotes them too).
psql "$DATABASE_URL" -c \
  'SELECT "createdAt", action, "entityType", "entityId" FROM audit_logs WHERE "sessionId" = '\''sess_...'\'' ORDER BY "createdAt"'
```

Then read what the platform owes the account — the warnings that do not depend on a handset:

```bash
curl "http://localhost:4000/api/v1/notifications?unreadOnly=true" \
  -H "authorization: Bearer $TOKEN"
# -> { "count": 1, "unreadCount": 1, "notifications": [ { "type": "SESSION_REVOKED",
#      "title": "Your session was ended for your protection", "read": false,
#      "details": { "familyId": "sess_...", "reusedSessionId": "sess_..." } } ] }

# Acknowledge the ones you have seen: {} means everything outstanding, { "ids": [...] } narrows it
curl -X POST http://localhost:4000/api/v1/notifications/read \
  -H "authorization: Bearer $TOKEN"
# -> { "markedRead": 1, "unreadCount": 0 }
```

A pending or rejected account can authenticate and read `/auth/me` (which carries
`approvalStatus` and `approvalReason`), but every permission-bearing route answers 403
`ACCOUNT_NOT_APPROVED` until an admin approves it. Admins work the queue with the
endpoints below; the seeded pilot accounts are already approved and never appear in it:

```bash
# Admin review queue (admin access token required; defaults to PENDING)
curl "http://localhost:4000/api/v1/admin/registrations?status=PENDING&role=MERCHANT" \
  -H "authorization: Bearer $ADMIN_TOKEN"

# Which applications cannot be approved as filed, before you try one and get a 400 back.
# Each carries readiness.blockedBy: the field to fix, whether the approve body can carry it,
# and what to do when it cannot (a licence another store holds is a decision, not data entry).
curl "http://localhost:4000/api/v1/admin/registrations?approvable=false" \
  -H "authorization: Bearer $ADMIN_TOKEN"
# -> { "count": 1, "summary": { "count": 5, "approvable": 4, "blocked": 1, "possiblyTruncated": false },
#      "registrations": [ { "role": "MERCHANT", "readiness": { "approvable": false,
#          "blockedBy": [ { "code": "SHOP_ADDRESS_MISSING", "field": "address",
#                           "fixableByReviewer": true, "remedy": "Pass an `address` object ..." } ] } } ] }
# possiblyTruncated=true means the status/role set filled the page, so more may match.

# Approve or reject (a rejection requires a reason, which the applicant can read back)
# Approval also creates the profile the role works from: a store (with its shop address)
# for a merchant, a rider profile for a driver — and returns it as `profile`. An older
# application can be completed by the reviewer: {"address": {...}} supplies a shop address,
# and {"rider": {"nidNumber": "...", "vehicleType": "motorcycle"}} supplies a rider's
# identity and vehicle, each field independently. Which fields were reviewer-supplied is on
# the audit row; the values are not, because an identity number does not belong in a log.
curl -X POST http://localhost:4000/api/v1/admin/registrations/<userId>/approve \
  -H "authorization: Bearer $ADMIN_TOKEN"
curl -X POST http://localhost:4000/api/v1/admin/registrations/<userId>/reject \
  -H 'content-type: application/json' -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "reason": "NID photo is unreadable" }'
# Both decisions are recorded in audit_logs as REGISTRATION_APPROVE / REGISTRATION_REJECT,
# and a rejection also warns the applicant in their own notice list.

# Suspend an account: one transaction, so the flag and the sessions it retires cannot drift
# apart. An access token is accepted while its session is alive, so a suspension that only
# flipped the flag would leave the account working for the rest of its 15 minutes.
curl -X POST http://localhost:4000/api/v1/admin/users/<userId>/suspend \
  -H 'content-type: application/json' -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "reason": "Chargeback fraud reported by two merchants" }'
# -> { "success": true, "account": { "isActive": false }, "revokedSessions": 2 }
# The owner is warned on both channels; neither administrator accounts nor the caller's own
# account can be suspended here (400), and suspending twice is 409 rather than a no-op.

# Reinstate: no body, revokedSessions always 0 — the retired sessions stay retired, and the
# owner signs in again, which is where the suspension notice is waiting for them.
curl -X POST http://localhost:4000/api/v1/admin/users/<userId>/reinstate \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

An approved merchant runs its own shopfront — no administrator in the loop. The store is found
by the account that owns it, so there is no id to point at somebody else's. Approval builds the
store from the onboarding answers in the same transaction that approves the account, and a
merchant that somehow has no store (a migration, a lost row) opens one rather than needing an
administrator to write it:

```bash
# Open a store: the merchant's own answer to the questions approval would have asked, including
# the licence registration already took and checks for uniqueness. 409 if the account already has
# a store (which is why the read below is the usual first step), or if another holds the licence.
curl -X POST http://localhost:4000/api/v1/merchant/profile \
  -H 'content-type: application/json' -H "authorization: Bearer $MERCHANT_TOKEN" \
  -d '{ "businessName": "Kolatoli Kitchen", "tradeLicenseNumber": "TRAD-CXB-2026-4471",
        "address": { "streetAddress": "Plot 7, Kolatoli Beach Road", "area": "Kolatoli",
                     "district": "Cox'\''s Bazar", "postalCode": "4700" } }'
# -> 201 { "merchant": { "id": "merch_…", "isOpen": true, "rating": 5,
#      "phone": "+880…", "address": { "label": "Shop", "isPiiRestricted": false }, … } }
# phone, rating, id and ownerUserId are the platform's: sent in the body, each is a 400 naming it.

# What the store says about itself, its shop address, and exactly what can be changed
curl http://localhost:4000/api/v1/merchant/profile -H "authorization: Bearer $MERCHANT_TOKEN"
# -> { "merchant": { "businessName": "Cox's Seafood & BBQ Express", "isOpen": true,
#      "tradeLicenseNumber": "TRAD-CXB-2024-9981", "rating": 4.8,
#      "editable": ["businessName", "description", "category", "isOpen", "address"] } }

# Rename it, move it, close it for the day
curl -X PATCH http://localhost:4000/api/v1/merchant/profile \
  -H 'content-type: application/json' -H "authorization: Bearer $MERCHANT_TOKEN" \
  -d '{ "description": "Fresh Bay of Bengal seafood", "isOpen": false,
        "address": { "streetAddress": "Plot 22, Kolatoli Beach Road", "area": "Kolatoli",
                     "district": "Cox'\''s Bazar", "postalCode": "4700" } }'
# -> { "changed": ["description", "isOpen", "address"], "merchant": { ... } }
# The shop address is edited in place, so orders already naming it still point at the shop.
# Closing is real: placing an order for a closed store answers 400.
# The licence, the account's phone and the rating are refused by name — a merchant cannot
# change the terms it was approved on. Every change is audited as MERCHANT_PROFILE_UPDATE.

# Stock the shop. A newly approved store starts with an empty catalogue, and an empty one
# cannot be ordered from at all, so this is what makes an approved account a working store.
curl -X POST http://localhost:4000/api/v1/merchant/catalog \
  -H 'content-type: application/json' -H "authorization: Bearer $MERCHANT_TOKEN" \
  -d '{ "name": "Chittagong Mezban Beef", "priceBdt": 320.5,
        "description": "Slow-cooked beef in the Mezban style" }'
# -> 201 { "item": { "id": "cat_…", "category": "Restaurant", "sku": "CXB-4A91C0F27D",
#             "isAvailable": true, "editable": ["name", "description", "category",
#             "priceBdt", "isAvailable", "imageUrl"] } }
# The category fell back to the store's own, and the SKU is the platform's: it is unique
# across every store, so a self-service one could be taken from another merchant.

# Reprice it, or take it off the menu for the day without deleting what customers bought
curl -X PATCH http://localhost:4000/api/v1/merchant/catalog/cat_9f2c1d0a7b3e4f5a6c81 \
  -H 'content-type: application/json' -H "authorization: Bearer $MERCHANT_TOKEN" \
  -d '{ "priceBdt": 350, "isAvailable": false }'
# -> { "changed": ["priceBdt", "isAvailable"], "item": { ... } }
# An unavailable item stays on the merchant's own list and leaves the orderable menu:
# quoting or placing an order for it answers 400 "currently out of stock".

# Remove an item nobody has ordered; one that was ordered answers 409 and names the switch
curl -X DELETE http://localhost:4000/api/v1/merchant/catalog/cat_9f2c1d0a7b3e4f5a6c81 \
  -H "authorization: Bearer $MERCHANT_TOKEN"
# -> { "deletedItemId": "cat_…" } · 409 for an item that is part of an order's history
# Every change is audited as CATALOG_ITEM_CREATE / CATALOG_ITEM_UPDATE / CATALOG_ITEM_DELETE,
# and the store is found by the account that owns it, so an item id cannot be pointed elsewhere.
```

Seeded pilot accounts (all four are real database rows, one per role):

| Role | Phone |
| :--- | :--- |
| Admin | `+8801811000001` |
| Merchant | `+8801811000002` |
| Driver | `+8801811000003` |
| Customer | `+8801811000004` |

### 4. Exercising the order flow

Order endpoints require the customer's access token, and customerId comes from the token:
the body may omit it, but a value that contradicts the token is rejected with 403.

```bash
# 1. Discover a merchant and its server-side prices (public)
curl http://localhost:4000/api/v1/merchants/merch_store_001/menu

# 2. Save where it should be delivered (a freshly registered customer has no address yet)
curl -X POST http://localhost:4000/api/v1/addresses \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{
  "streetAddress": "House 12, Road 3, Kolatoli", "area": "Kolatoli",
  "district": "Cox'\''s Bazar", "postalCode": "4700" }'
# -> { "address": { "id": "addr_…", "isDefault": true, … } }

# 3. Quote an order (prices are always recomputed server-side)
curl -X POST http://localhost:4000/api/v1/orders/quote \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{
  "merchantId": "merch_store_001", "deliveryAddressId": "addr_cust_001",
  "serviceArea": "cox_bazar_sadar", "distanceKm": 3,
  "items": [{ "itemId": "cat_item_002", "quantity": 1 }] }'# 4. Place the order (Idempotency-Key makes retries safe, even after a restart)
curl -X POST http://localhost:4000/api/v1/orders \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -H 'idempotency-key: demo-1' -d '{ ...same body, or omit deliveryAddressId to use
  the default address saved in step 2... }'

# 5. Read its status (the owning customer, or the merchant fulfilling it)
curl http://localhost:4000/api/v1/orders/<orderId> -H "authorization: Bearer $TOKEN"
```

Retrying step 4 with the same `Idempotency-Key` returns the order that already exists
(`201`, same `order.id`) rather than placing a second one — after a crash, a deploy, or
from another process on the same database, because the key and its answer are rows in
`idempotency_keys`. The key is scoped to the account and the endpoint, so two customers may
use the same value without ever seeing each other's order; a key reused with a different
payload, or a duplicate that arrives while the first attempt is still running, answers
`409`. Keys are kept for an hour.

Money moves through three guarded routes, each requiring an `Idempotency-Key`:
`POST /orders/:id/payments` records a completed payment for the customer's own order (the
amount comes from the order, never the body, and one order can only ever be paid once),
`POST /orders/:id/cancel` lets the customer end their own order and writes the refund the
cancellation policy allows — 100% before the merchant accepts, less half the items subtotal
once cooking has started, and nothing at all for an order that was never paid — and
`POST /orders/:id/refunds` lets an administrator send money back afterwards, in parts if
needed. A repeated request with the same key returns the stored `payment.id` / `refund.id`;
a *different* key asking for the same money is refused, because what has been taken and
returned is read and written inside one write transaction. There is no gateway call here:
the platform keeps the ledger (`payments`, `refunds`).

Addresses are the customer's own: `GET /addresses` lists them (default first),
`PATCH /addresses/:id` edits one, and `DELETE /addresses/:id` removes one. An address an
order was delivered to cannot be deleted — the order names it, and that delivery's history
has to keep resolving — so the row is detached rather than refused: gone from the listing,
from `GET`/`PATCH` by id and from the addresses an order may be sent to, kept only as what
those orders say they were sent to (`outcome: "DETACHED"`, with `ordersKeepingIt`), and no
longer counted against the ten an account may keep. Another customer's address answers `404`
rather than `403`, so a guessable id never confirms that it exists, and a detached one answers
the same way. A candidate needs `address:manage:own`, which only the customer and admin roles
hold.

Because that row is shared and editable, every order also keeps its own copy of where it went,
taken when it is placed (`orders.deliveryAddressSnapshot`): correcting an address later cannot
rewrite what a finished delivery says about itself. `GET /orders/:id` and the placement reply
carry it as `deliveryAddress`, to the customer it was delivered to and to a role holding
`pii:read:full` — a store reads its sale without the customer's door.

An address's coordinates must be somewhere the fleet goes. The ten pilot zones
(`src/modules/areas/serviceAreaManager.ts`) had been configured and consulted by nothing, so
an address in Dhaka saved as happily as one in Kolatoli; `POST`/`PATCH /addresses` now ask
that manager — the zone's own bounding box, its 25 km fallback radius, and whether it is
taking work — and refuse a point in no zone, or in one that is suspended, with a `400` that
names the zone it landed in (`serviceArea`) and the reason (`reason`). Saint Martin's Island
is `RESTRICTED` rather than suspended, so an address there is accepted. Coordinates stay
optional: an address saved without them cannot be judged by this gate, which is the honest
limit of a rule that reads coordinates.

Authorization is permission-based (`src/auth/rbac.ts`): placing or quoting an order needs
`order:create` (customer role), reading one needs `order:read:own` / `order:read:merchant`
plus ownership, and admins hold `order:read:all`. Unauthenticated calls get 401, wrong
roles or foreign orders get 403.

A rider's duty state is their own to change, and it is what makes them dispatchable:

```bash
# Read it (a rider's own grant; an approved rider starts OFF_DUTY)
curl http://localhost:4000/api/v1/drivers/me/duty -H "authorization: Bearer $RIDER_TOKEN"
# -> { "duty": { "dutyStatus": "OFF_DUTY", "available": false, "settable": ["AVAILABLE", "ON_BREAK", "OFF_DUTY"] } }

# Go on duty, take a break, come off it
curl -X PATCH http://localhost:4000/api/v1/drivers/me/duty \
  -H 'content-type: application/json' -H "authorization: Bearer $RIDER_TOKEN" \
  -d '{ "status": "AVAILABLE" }'
# -> { "changed": true, "duty": { "dutyStatus": "AVAILABLE", "available": true } }
# Asking for the state you are already in answers changed:false rather than refusing.
# ON_DELIVERY is refused: dispatch sets it while an order is in the rider's hands, and a rider
# carrying one cannot leave the roster (409) until it is handed over.

# And the roster dispatch works from (administrators): who is on duty, who to call first
curl "http://localhost:4000/api/v1/drivers/roster?zoneId=kolatoli" \
  -H "authorization: Bearer $ADMIN_TOKEN"
# -> { "count": 1, "riders": [ { "fullName": "Rahim Uddin", "phone": "+8801811000003",
#      "vehicleType": "MOTORCYCLE", "dutyStatus": "AVAILABLE", "available": true } ] }
# Available riders come first; ?dutyStatus=ALL adds the ones who are off duty, and a suspended
# account is not on it at all.

# The deliveries assigned to the rider: what the duty state is for, and where the PII rule lands.
# Requires order:read:driver — the rider grant, which until this route existed no endpoint used.
curl "http://localhost:4000/api/v1/drivers/me/orders?status=CONFIRMED" \
  -H "authorization: Bearer $RIDER_TOKEN"
# -> { "count": 1, "query": { "status": "CONFIRMED", "limit": 100 },
#      "orders": [ { "orderNumber": "CXB-2025-0001", "status": "CONFIRMED",
#        "merchant": { "id": "merch_store_001", "businessName": "Cox's Seafood & BBQ Express" },
#        "deliveryAddress": { "label": "Home", "streetAddress": "Flat 4B, Sugandha View, Hotel Motel Zone",
#          "area": "Sugandha", "city": "Cox's Bazar", "latitude": 21.4258, "longitude": 91.9723,
#          "deliveryInstructions": "Please include extra lime and chutney." },
#        "totalBdt": 1460 } ] }
# The address is served through maskAddress (src/auth/pii.ts), the same rule every other viewer
# goes through: an assigned rider reads the door they are delivering to, and the customer's
# account id is not in the payload at all. Ownership is the query — driverId comes from the
# token — so another rider's deliveries, and an order nobody has accepted, are simply not listed.
# ?limit= bounds the page (default 100, max 200); a state the platform does not have is a 400.
```

Health check: `GET /health` reports live database connectivity (exempt from rate limits).
Every other route allows 100 requests a minute per client address by default
(`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`). That budget is counted in the database and
keyed by a digest of the client address, so every process serving the same clients shares
one allowance instead of repeating it, and the table never holds an address. See
`TRUST_PROXY` above for how the client address is decided behind a proxy.

---

## 🧪 Test Suite & Quality Assurance

Execute all automated unit and integration tests across cart calculations, delivery fee matrix, dispatch routing, and payment verification:

```bash
# Run all tests (includes the end-to-end order flow over the HTTP API)
npm test

# Type-check only
npm run lint
```

`tests/postgresBackend.test.ts` needs a PostgreSQL server, and is the only suite that is skipped
when there is none — loudly, naming the URL it tried, because a quiet skip reads as a pass. It
creates a schema of its own, migrates the platform into it, and drops it afterwards, so it can
be pointed at any database without disturbing anything else in it:

```bash
docker run -d --name cxb-pg-test -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' \
  npx vitest run tests/postgresBackend.test.ts
```

One test is a rule rather than a case. `tests/routeAuthorization.test.ts` declares who may call
each route the API registers — public or authenticated, the permission it needs, and whether an
account still awaiting review may reach it — diffs that declaration against the live route table
in both directions, and then has the running API prove it: 401 without a token, 403 naming the
permission for a role that lacks it, and the review gate answered exactly as declared. Adding a
route without declaring its access fails the suite, so authorization cannot be decided by
omission.

Two suites exercise the deployment rather than a single server, because some guarantees are
about what several instances sharing one database do together, and a pair of servers inside
one process cannot see a good deal of them. `tests/serverProcesses.ts` starts the built API as
real child processes (`node dist/main.js`, separate PIDs, one database file) for both.
`tests/rateLimitAcrossProcesses.test.ts` spends one request budget across two servers — and,
with real processes, shows the fourth request refused *between* them rather than by each one
separately — while `tests/orderIdempotencyAcrossProcesses.test.ts` races the same
`Idempotency-Key` at both processes: exactly one order row, one `order.id`, and a retry
against either process returning that same answer. If `dist/` is missing or older than `src/`,
those tests compile the project first — they must never pass against stale output.

---

## 👥 Pilot Operations Zone Map

- **Zone 1 (Kolatoli Beach & Hotel Corridor)**: High density tourist hotels, evening seafood grills.
- **Zone 2 (Laboni Beach & Burmese Market)**: Shukti / dry fish, souvenir retail, beach snacks.
- **Zone 3 (Sugandha Point & Main Town)**: Grocery, local restaurants, residential pharmacies.
- **Zone 4 (Marine Drive & Inani)**: Scheduled premium deliveries to remote resorts.

---

## 📄 License

Licensed under the [MIT License](LICENSE).
