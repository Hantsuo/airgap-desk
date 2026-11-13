# Airgap Desk

**An offline-first claims inspection desk that can prove what it did *not* send.**

Built for **#BuildHybridAI 2026** (Google / Firebase). Web + Chrome only.

- Public demo: <https://airgap-desk.web.app/>
- Agent manifest: <https://airgap-desk.web.app/.well-known/agent.json>
- Receipt verifier: <https://airgap-desk.web.app/verify/>

All data in the demo is synthetic. `SYNTHETIC DATA` is shown on every screen.

---

## What it does

1. **Capture on site, offline.** Notes and photos are written to IndexedDB. Nothing is uploaded.
2. **Extract on the device.** Chrome's built-in Gemini Nano (through Firebase AI Logic, `ONLY_ON_DEVICE`) turns the notes into a draft.
3. **Build an egress manifest.** Every field is classified; a deterministic rule engine redacts names, ID numbers, phones, addresses, hospital names, bank data and medical text. Each line shows what stays, what leaves, how many characters go in and come out, what was removed, and why.
4. **Approve item by item.** Any single line can be blocked. "Keep everything on this device" is the same size as "Approve and send".
5. **Sign a receipt at send time.** Canonical JSON → SHA-256 hash chain → Ed25519 signature. The private key never leaves IndexedDB. The receipt carries its own public key.
6. **Read back from the cloud, with citations.** The cloud only ever sees the approved, redacted payload. Every conclusion must quote the policy text verbatim; this laptop checks the quote character by character, plus a single-turn on-device check. A conclusion that fails is returned and is not written into the report.
7. **Verify anywhere.** `/verify` runs entirely in the browser. Change one character of a receipt and the signature fails.

---

## Architecture

```
Next.js 16 (static export) + TypeScript
  src/lib/db.ts          Dexie / IndexedDB: cases, evidence, drafts, manifests, receipts, reports, soak samples
  src/lib/hybrid-llm.ts  nano (ONLY_ON_DEVICE) · cloud (PREFER_IN_CLOUD) · mock (offline rules)
  src/lib/egress.ts      sensitivity classification + deterministic redaction + manifest model
  src/lib/receipt.ts     canonical JSON, SHA-256 chain, Ed25519 (WebCrypto, noble fallback), verify
  src/lib/review.ts      cloud prompt, citation check, on-device semantic check
  src/app/capture        field capture
  src/app/draft          local draft
  src/app/egress         egress manifest
  src/app/review         receipt + cloud read-back + report draft
  src/app/verify         public receipt verification
  src/app/soak           soak harness (not part of the demo path)
```

The on-device path is locked to `InferenceMode.ONLY_ON_DEVICE`. There is no silent cloud fallback: if the device model is unavailable, the UI says so and the local rule engine takes over. The cloud is only called from the egress gate's approved payload.

---

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in the Firebase web config and an App Check debug token
npm run dev                  # http://127.0.0.1:3000
```

Requirements for the on-device path: Chrome desktop 139+, a downloaded Gemini Nano model, and a real user gesture before `initializeDeviceModel()`.

`.env.local` is gitignored. The Firebase web config is public by design; the App Check debug token is not meant for production.

---

## Offline behaviour (measured, not claimed)

| Scenario | Result |
|---|---|
| **First ever visit, network already down** | **Does not work.** The browser has nothing cached, so the page cannot load. Measured: `net::ERR_INTERNET_DISCONNECTED`. |
| Visit once online, then reload with the network down | **Works.** A service worker caches the app shell (14 resources in the measured run); the reload renders and the local path (view, type, local draft) stays usable. |
| Page already loaded, then the network disappears | Works; this was measured in G1/G2 (on-device extraction 2.35 s, no cloud call). |

So the honest promise is: **once the app has loaded on this laptop, it keeps working without a network.** It is not a cold-start-offline application, and we do not claim one.

If the device model is missing at that moment, the status bar switches to "Egress protection reduced: you confirm every item" and extraction falls back to the local rule engine — visibly.

---

## Deploy

Firebase Hosting, static export:

```bash
npm run build            # emits out/
firebase deploy --only hosting --project airgap-desk
```

The public build embeds the App Check **debug** token so the demo works from any browser. That is a demo-only decision: a production deployment would use a real attestation provider (reCAPTCHA Enterprise) and no debug token. The token is scoped to this Firebase app and the project is on the free Spark plan.

---

## Limits

- Chrome desktop only; no Android, iOS, or Safari.
- On-device inference is single-turn text and capped at 9,216 tokens. Audio and PDFs are not supported on device.
- The cloud call latency varies widely (2.7 s to 74 s observed); the UI has a re-run button.
- After roughly 10 minutes idle, the first on-device generation can time out (`device/generate-timeout`); pressing Generate again recovers. Reproduced three times. It is not data loss.
- Offline soak: 127 minutes, 60 samples at 2-minute intervals, 60/60 successful. That is not a claim of 2–4 hours of continuous work; the interval was 2 minutes.
- The report draft is stored locally in IndexedDB; there is no export to PDF yet.

## Licence

MIT (see `LICENSE`).

