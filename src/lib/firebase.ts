import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check';

/**
 * Browser-only Firebase init. Config is public by design; the debug token is
 * supplied through .env.local and must never reach a production build.
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '',
};

let app: FirebaseApp | null = null;
let appCheck: AppCheck | null = null;

export function isFirebaseConfigured() {
  return Boolean(config.apiKey && config.projectId && config.appId);
}

export function getFirebaseApp(): FirebaseApp {
  if (typeof window === 'undefined') throw new Error('Firebase is browser-only in this app');
  if (!isFirebaseConfigured()) throw new Error('Firebase config missing: copy .env.example to .env.local');
  if (app) return app;

  const token = process.env.NEXT_PUBLIC_APPCHECK_DEBUG_TOKEN;
  if (token) {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = token;
  }

  app = initializeApp(config);
  appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('debug-provider-placeholder'),
    isTokenAutoRefreshEnabled: true,
  });
  return app;
}

export function getAppCheck(): AppCheck | null {
  return appCheck;
}
