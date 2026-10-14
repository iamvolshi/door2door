# Door2Door — customer app (Expo / React Native)

Food-ordering app for Cox's Bazar Door2Door. Talks to the backend API in the repo root
(see `../docs/API.md`, including the "Mobile client contract" section — read that before
touching `src/api.ts`).

## What you need

- Node.js ≥ 22 on your computer
- The backend running and reachable (see below)
- An Android phone with **Expo Go** installed (Play Store), on the **same Wi-Fi** as your computer
- No Android SDK, no emulator, no build step for development

## 1. Start the backend

From the repo root (not this folder):

```bash
npm run build
PORT=4000 HOST=0.0.0.0 SQLITE_STORAGE_PATH=./data/app.sqlite node dist/main.js
```

`HOST=0.0.0.0` matters: `localhost` would refuse connections from the phone. Leave this
terminal running. Sanity check from the computer: `curl http://127.0.0.1:4000/health`.

## 2. Point the app at your computer

The phone cannot use `localhost` (that would mean the phone itself). `src/config.ts` holds
the LAN address the app calls:

```ts
export const API_BASE_URL = 'http://192.168.1.63:4000/api/v1';
```

If your machine's IP differs, find it (`ipconfig` on Windows → IPv4 Address, `ip a` /
`ifconfig` elsewhere — pick the `192.168.x.x` / `10.x.x.x` one, not a `172.x` Docker
address) and update that line. Verify from the computer first:
`curl http://<that-ip>:4000/api/v1/merchants` should return JSON.

## 3. Run the app

```bash
cd mobile
npm install
npx expo start
```

Scan the QR code with Expo Go. First load takes ~30s while the bundler builds; reloads
after edits are instant.

## 4. Test drive (no real SMS needed)

The backend runs in mock-SMS mode locally, so the login code is shown on-screen:

1. Enter any `+8801XXXXXXXXX` number → **Send code**
2. The code screen displays the test code — type it in → **Confirm**
3. New number? Enter your name → **Create account**
4. Browse the storefront → open the menu → **Add** items → **Checkout**
5. First order asks for a delivery address (street / area / district) — it is saved and
   reused afterwards
6. **Place order · Cash** → order is placed, cash-on-delivery recorded, tracking screen
   opens and refreshes every 5s. **My orders** lists everything placed on that phone.

## Troubleshooting

| Symptom | Fix |
|---|---|
| QR scans but bundle never loads | Phone and computer on different networks (guest Wi-Fi isolates clients). Join the same private Wi-Fi; some routers need "AP isolation" turned off. |
| `Network request failed` in the app | `src/config.ts` IP is wrong or stale (DHCP changes it). Re-check step 2. Also allow Node through Windows Firewall when prompted (ports 4000 and 8081). |
| `Too many tries — wait Ns` | Rate limiter or the 60s OTP resend cooldown. Wait it out; the resend timer comes from the server, not a guess. |
| Signed out unexpectedly after refresh | By design if the refresh token was reused (theft response) — see the mobile contract. A double-tap on confirm cannot cause this; concurrent refreshes from two processes can. |
| Backend `4000: already in use` | A previous `node dist/main.js` is still running — stop that terminal first. |

## Branding

Every screen ends with a small footer — `a VOLSHi product` — rendered once in the
`Shell` component in `App.tsx`, with `VOLSHi` linked to `https://volshi.com` via
`Linking.openURL`. To change the word, URL, or styling, edit the footer block and
the `footer` / `footerText` / `footerLink` styles at the bottom of `App.tsx`.

## Project layout

- `App.tsx` — screens (phone → code → register → home → menu → checkout → track/orders), no navigation library
- `src/api.ts` — HTTP client: in-memory access token, refresh token in Keychain/Keystore via `expo-secure-store`, single in-flight refresh, idempotency keys, `Retry-After` handling
- `src/auth.tsx` — session state, boot restore, OTP + registration, logout
- `src/config.ts` — the one line that names the backend

## Toward production

- Replace the LAN URL with `https://your-domain/api/v1` in `src/config.ts`
- Configure a real SMS provider on the backend (`SMS_PROVIDER`, gateway credential) — the on-screen test code only appears in non-production mock mode
- `npx eas build` for a standalone APK/AAB; `expo-secure-store` already uses Keychain/Keystore, so stored tokens stay compliant
