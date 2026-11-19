# Pitch (Devpost text)

Everything demoed is SANDBOX: simulated payments, no real bitcoin, fixed demo rate. Real Lightning was only exercised on regtest (spike S1).

## Inspiration

Selling over Lightning usually needs a data connection on the selling phone, or a dedicated hardware device. Sellers whose data drops or runs out mid-sale are the case we designed for. LNURLPoS showed that the burden of connectivity can be taken away from the point of sale and given to the phone. Its author also lists offline sats pricing as too volatile, and that is the open problem we wanted to solve. Jaay is Wolof for "to sell".

## What it does

The merchant types a price in XOF and the phone shows an LNURL-pay QR, even in airplane mode. The customer scans with any LNURL-pay wallet, and the server converts XOF to sats at scan time with a 120 s quote lock. The invoice is created on the merchant's own wallet through a receive-only connection. After payment the wallet shows a receipt link, and the receipt page shows a 6-digit code only once the invoice has settled. The merchant types the code, the phone checks it, and when online the phone reconciles every sale and flags any sale confirmed without a payment.

## How we built it

It is a TypeScript pnpm monorepo: a pure Web Crypto protocol package, a Hono server, an offline-first Vite PWA and a customer wallet simulator. The QR carries an AES-256-GCM sealed payload with a random 96-bit IV and the device id as AAD. The server talks to the merchant wallet over Nostr Wallet Connect (NIP-47), an LNbits invoice key, or a labeled SANDBOX backend. The phone keeps an IndexedDB sale ledger and signs its API calls with HMAC. We wrote the tests first for protocol, crypto and server logic.

## Challenges we ran into

Offline pricing is hard because a sats price goes stale, so the payload carries XOF and the server prices at scan time. Confirming a payment with no network means trusting a code, so the code is gated by settlement, derived on the device, limited to 3 attempts, and backed by reconciliation. Proving receive-only was tricky, so enrollment refuses any NWC connection that grants pay_invoice and the server re-checks the live permissions on every Wallet refresh. Getting real Lightning on regtest took a custom stack (Alby Hub on regtest LND). Whether real wallets show the LUD-09 receipt link was researched but tested only with the simulator.

## Accomplishments we are proud of

The PWA first load is 32.4 KB gzipped and the receipt page is under 15 KB with no JavaScript. The POS shell works offline after the first load, including a cold start offline, checked by a Playwright test. We have 127 protocol, 169 server, 146 PWA and 33 simulator tests, plus fast-check fuzz tests with a fixed seed and 14 Playwright checks at 320, 360 and 412 px. The threat model lists 27 threats and names 70 tests, checked by `pnpm security:matrix`. The wallet is receive-only with no send button anywhere.

## What we learned

Receive-only is enforced by the wallet service, so the app can only refuse and warn, not guarantee. A security claim is more convincing when a test is named next to it. Prior art matters: the confirm-code idea comes from the LNURLPoS lineage, and saying so is part of the design. Honest labels (SANDBOX, fixed demo rate, NOT RUN) cost little and keep trust. The next step is to check these assumptions with merchants in person.

## What is next

Pilot with one Bitcoin-accepting merchant in Dakar. Test real wallets on signet with the receipt link. Add device revoke and a passcode-wrapped key. Have Wolof strings reviewed by a native speaker. Stretch: a signed receipt as a Nostr event.

## Elevator pitch (English)

Jaay is a point of sale that works with no signal. The merchant types a price in XOF on their own phone, in airplane mode, and a QR code appears. The customer scans it with any LNURL-pay wallet. A server converts the price to sats at scan time, not when the QR was made, and creates the invoice on the merchant's own wallet through a receive-only connection. After payment the customer opens a receipt link and sees a 6-digit code, but only once the payment has settled. The merchant types the code and the phone confirms the sale. When the phone is back online, it reconciles every sale and flags any confirmed without payment. No extra hardware, a written threat model with 27 threats and 70 named tests, and a receipt page under 15 KB. Demo is SANDBOX: simulated payments, no real bitcoin.

## Présentation éclair (français)

Jaay est un point de vente qui marche sans réseau. Le commerçant tape un prix en XOF sur son propre téléphone, en mode avion, et un QR code apparaît. Le client le scanne avec n'importe quel portefeuille LNURL-pay. Un serveur convertit le prix en sats au moment du scan, et non à la création du QR, et crée la facture sur le portefeuille du commerçant par une connexion en réception seule. Après le paiement, le client ouvre un lien de reçu et voit un code à 6 chiffres, mais seulement une fois le paiement réglé. Le commerçant tape le code et le téléphone confirme la vente. Quand le téléphone retrouve le réseau, il rapproche toutes les ventes et signale celles confirmées sans paiement. Aucun matériel en plus, un modèle de menaces écrit avec 27 menaces et 70 tests nommés, et une page de reçu de moins de 15 Ko. La démo est en SANDBOX : paiements simulés, aucun vrai bitcoin.
