# Demo script: 3:00 video storyboard

Target 2:50, hard limit 3:00. English captions. Everything is SANDBOX (simulated payments, no real bitcoin, fixed demo rate) except the one segment labeled REGTEST. Show the SANDBOX label on screen whenever sandbox is on. Flow follows section 6 of [WINNING_STRATEGY.md](WINNING_STRATEGY.md). Criteria order: usefulness, working MVP offline, security, low bandwidth, docs.

| Time | On screen | What is said | Asset or command |
|---|---|---|---|
| 0:00 to 0:15 | Title "jaay, Sell without signal." Then a market stall mock caption: "Data drops mid-sale." | "Jaay is a point of sale for sellers whose data drops or runs out mid-sale. It takes Lightning payments with the phone in airplane mode." | Wordmark, caption slide |
| 0:15 to 0:35 | Merchant phone, airplane mode on, status bar visible. Keypad: 2,500 XOF. QR appears. SANDBOX banner visible | "Airplane mode, status bar visible. I type 2,500 XOF and the QR appears. No network used." | `pnpm demo`, open http://localhost:8787/app/. Screens: docs/screens/sell.png |
| 0:35 to 0:55 | Customer simulator (SANDBOX label) shows the sats amount and the XOF price, then Pay (simulated) | "The customer scans with any LNURL-pay wallet. The server converts XOF to sats at scan time, with a quote lock. This is the sandbox simulator at a fixed demo rate." | http://localhost:8787/sim/. docs/screens/sim-request.png, sim-paid.png |
| 0:55 to 1:15 | Receipt link opens, big 6-digit code. Merchant types it, PAID shown, airplane icon still visible | "After payment the wallet shows a receipt link. The code appears only now. The merchant types it and the phone confirms, still offline." | docs/screens/receipt-after.png, confirm.png |
| 1:15 to 1:30 | Reconnect. Sales tab, Check with server. The sale locked earlier by 3 wrong codes moves to Attention as unpaid; paid sales show paid | "Back online, the phone checks every sale with the server. A sale that was never paid cannot stay confirmed or open: it is flagged." | Before recording, lock one sale with 3 wrong codes while offline. docs/screens/ledger.png. The confirmed-but-unpaid (leaked code) case is shown by the e2e test output, check b |
| 1:30 to 1:45 | Wallet screen, badge "Receive only. This app and the server cannot spend." Details collapsed then opened | "The wallet connection is receive only. Enrollment refuses any connection that can spend. There is no send button." | docs/screens/wallet.png |
| 1:45 to 1:55 | REGTEST label on screen. Terminal: the opt-in regtest golden path, a real invoice created through the receive-only Alby Hub NWC connection and paid by the regtest payer node, PASS lines | "This one is real Lightning, on regtest only, through a receive-only connection. No real funds." | In WSL: `bash spikes/s1-nwc/scripts/stack.sh`, then `pnpm --filter @jaay/server test:regtest` (see spikes/NOTES.md, S1) |
| 1:55 to 2:15 | Attack beat 1: in a terminal, request `/lnurlp?p=` with the sale token and one character changed. Answer: `{"status":"ERROR","reason":"Invalid or expired sale"}` | "Change one character of the sealed payload and the server rejects it. Every failure gives the same answer, so an attacker learns nothing." | Token from the simulator's "What a wallet sees" panel; `curl "http://localhost:8787/lnurlp?p=<edited token>"`. Do not edit the LNURL text itself: its checksum makes the wallet refuse it before the server sees it |
| 2:15 to 2:30 | Attack beat 2: open the receipt before paying. Shows "Not paid yet" and no code | "Open the receipt before paying: not paid yet, no code." | docs/screens/receipt-before.png |
| 2:30 to 2:40 | Attack beat 3: read the same QR again in the simulator after paying. Refused with the uniform error; before payment the same QR returns the same invoice (same payment hash) | "Replay a paid QR and it is refused. Scan it twice before paying and you get the same invoice, never a second sale." | Simulator, "What a wallet sees" panel |
| 2:40 to 2:50 | Sizes and tests: 32.4 KB first load, receipt under 15 KB, 14 e2e checks, security matrix of 27 threats and 70 tests | "Low bandwidth: 32.4 KB gzipped first load, receipt page under 15 KB with no JavaScript. 27 threats, 70 named tests." | `pnpm security:matrix` output. Do not show Lighthouse (NOT RUN) |
| 2:50 to 3:00 | README, docs/THREAT_MODEL.md, repo URL, "SANDBOX demo, MIT license" | "Open source, MIT. README, threat model and a French overview are in the repo. Built for the Dakar Bitcoin Hack by BTrust." | https://github.com/lijnati/Jaay |

## Pre-recording checklist

- [ ] Clean device state: Settings, Wipe device.
- [ ] Demo data loaded (Settings, Load demo data) before the reconcile beat.
- [ ] Regtest stack up for the real-Lightning segment (`bash spikes/s1-nwc/scripts/stack.sh` prints READY).
- [ ] Fixed demo rate label visible on every sandbox screen.
- [ ] Airplane-mode shot with the status bar visible.
- [ ] SANDBOX label visible whenever sandbox is on, REGTEST label on the real segment.
- [ ] No secrets on screen: no enrollment code, NWC string, master key or .env.
- [ ] Video under 3:00.
- [ ] English captions added.
