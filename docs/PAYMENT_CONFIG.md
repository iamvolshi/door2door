# Payment Gateway Integration Runbook: bKash, Nagad & Cash on Delivery (COD)

This guide explains how payment flows are architected, configured, and verified across digital MFS (Mobile Financial Services) and cash channels in Cox's Bazar.

---

## 1. Supported Payment Channels

1. **bKash Tokenized Checkout (PGW v1.2.0-beta)**
   - Seamless checkout & recurring auth for customer wallets.
   - Webhook & query payment verification.
2. **Nagad Merchant Direct Gateway**
   - RSA SHA-256 signed payloads.
   - Two-step payment encryption & verification callback.
3. **Cash on Delivery (COD)**
   - Supported on standard food & parcel deliveries up to BDT 3,000 threshold.
   - Driver cash wallet tracking and automated daily reconciliation.

---

## 2. bKash Tokenized Checkout Workflow

### Sequence Flow
```
[Customer App]   -->  [CXB Backend]   -->  [bKash PGW API]
 1. Checkout           2. Create Payment       3. Returns bkashURL & paymentID
 4. Redirect Webview   5. User PIN/OTP         6. bKash redirects to Callback URL
 7. Execute Payment    8. Verify TrxStatus     9. Confirm & Dispatch Order
```

### Backend Setup Steps
1. Ensure `.env` contains valid bKash credentials:
   ```env
   BKASH_BASE_URL=https://tokenized.sandbox.bka.sh/v1.2.0-beta
   BKASH_APP_KEY=your_app_key
   BKASH_APP_SECRET=your_app_secret
   BKASH_USERNAME=your_username
   BKASH_PASSWORD=your_password
   ```
2. Token grant call will automatically exchange app key & secret for an `id_token` valid for 3600 seconds, stored in backend memory/cache.

### Webhook & IPN Listener
- Callback endpoint: `POST /api/v1/payments/bkash/callback?paymentID={paymentID}&status={status}`
- On `status=success`, system calls `/tokenized/checkout/execute`.
- Idempotency guard: Transactions are double-checked against stored `paymentID` to prevent double crediting.

---

## 3. Nagad Direct Integration Setup

### RSA Cryptography Requirements
- Generate a 2048-bit RSA key pair for your merchant account.
- Upload your public key to Nagad Merchant Portal.
- Save your private key to `./secrets/nagad_merchant_private.pem`.
- Download Nagad's Public Key to `./secrets/nagad_pg_public.pem`.

### Payment Lifecycle
1. **Init (`/check-out/initialize/`)**: Merchant signs sensitive payload (`dateTime`, `orderId`, `sensitiveData`).
2. **Complete Callback (`POST /api/v1/payments/nagad/callback`)**: Verify Nagad's signature on payment reference ID.
3. **Verify (`/verify/payment/{paymentRefId}`)**: Confirm transaction status is `Success` and amount matches expected quote.

---

## 4. Cash on Delivery (COD) & Driver Wallet Protocol

### Rules for Cox's Bazar Pilot:
- **Maximum COD limit**: BDT 3,000 per single order (prevents fraud & driver exposure).
- **Driver COD Holding Limit**: BDT 8,000.
- When a driver reaches BDT 8,000 in un-remitted cash collected:
  - System pauses driver's dispatch queue for COD orders.
  - Driver must deposit cash at local hub (Laboni Point office or via bKash Merchant B2B cash drop) to reset limit.

### Daily Reconciliation Formula
$$\text{Merchant Payable} = \text{Item Subtotal} - \text{Merchant Commission (10-15\%)} + \text{Merchant Incentives}$$
$$\text{Driver Earnings} = \text{Base Fare} + (\text{Distance} \times \text{PerKmRate}) + \text{Surge} + \text{Tips}$$
$$\text{Platform Net} = \text{Commission} + \text{Customer Service Fee} - \text{Driver Subsidies}$$
