// The backend this app talks to.
//
// Development (Expo Go): the phone must reach your computer over the LAN — same
// Wi-Fi, and this IP must be your machine's LAN address (NOT localhost — localhost
// on the phone is the phone itself).
//
// Production (EAS build): set EXPO_PUBLIC_API_URL at build time, e.g.
//   eas build --platform android --profile production  (with EXPO_PUBLIC_API_URL
//   in eas.json env or your shell). It must be the https:// public URL.
const DEV_URL = 'http://192.168.1.63:4000/api/v1';
const fromEnv = (process.env.EXPO_PUBLIC_API_URL ?? '').trim();
export const API_BASE_URL = fromEnv !== '' ? fromEnv.replace(/\/+$/, '') : DEV_URL;
