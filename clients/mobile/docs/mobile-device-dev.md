# Testing the mobile app on a real iPhone (LAN dev lane)

The Simulator lane (`make dev-ios`) works because the Simulator shares the
Mac's loopback. A physical phone does not — it reaches the Mac only over the
LAN. This lane closes that gap for the **account surfaces** (sign-in,
sessions, QR link-login); host-backed surfaces (chats, terminals) stay
offline on the phone because the dev host's RPC socket is loopback-only.

## What the lane does

`make dev-ios-device` (from the **internal repo** root):

1. resolves this worktree's dev-run slot and reads its `run.json`,
2. re-addresses the slot's authn / cloud-ui URLs from `127.0.0.1:<port>` to
   `<mac-lan-ip>:<port>` — the services already bind `0.0.0.0`,
3. builds `dist/web` and starts a **second** Vite dev server bound to the LAN
   IP (the slot's own loopback server is untouched),
4. runs `cap run ios --live-reload` pointed at that LAN server, which
   installs a **Debug** build over cable.

Debug builds use `ios/App/App/Info-Dev.plist`, which carries the
App Transport Security exception plain-http LAN traffic needs. Release
builds keep the exception-free `Info.plist` — never add ATS exceptions
there.

## Prerequisites (once)

- Xcode signing works for team `7YVZ56DZ74` (open
  `traycer/clients/mobile/ios/App/App.xcodeproj` once and let it provision).
- Phone is in Developer Mode (Settings → Privacy & Security → Developer
  Mode), plugged in over USB, and **on the same Wi-Fi as the Mac**.
- `bun install && bun run setup` has been run at the internal repo root.

## The loop

Terminal 1 — the local stack (internal repo root):

```bash
make dev-gui-app
```

Wait for the port banner. Terminal 2 (internal repo root):

```bash
make dev-ios-device
```

- With no flags it auto-detects the Mac's LAN IP (`en0`, then `en1`) and
  prompts you to pick the device from Capacitor's target list — choose your
  phone (cable targets appear alongside simulators). Flags, all optional and
  passed through `ARGS`: `--target <udid>` (list with
  `xcrun xctrace list devices`), `--lan-ip <address>`, `--port <port>`.
- First run compiles + cable-installs the app (a few minutes). Later runs
  reuse the install; each app launch loads straight from the LAN Vite server,
  so TypeScript edits are live-reloaded — no reinstall.

Then the demo loop:

1. In a Mac browser, open the slot's gui-app URL (printed by
   `make dev-gui-app`) and sign in.
2. Open **Settings → Link a phone**. A QR renders and re-mints every 50 s.
3. On the phone: open Traycer → **Scan from desktop** → point at the QR.
   The phone signs in as its own `mobile` session (check Settings →
   Sessions on the desktop — a "Mobile app" row appears).

Camera denied or unavailable? The same panel has a code field — type the
code shown under the desktop QR.

## Simulator variant (no camera)

The Simulator has no camera, so the typed-code path IS the flow there — and
it needs only the normal loopback lane:

```bash
make dev-gui-app        # terminal 1
make dev-ios            # terminal 2, exactly one Simulator booted
```

In the Simulator: **Scan from desktop** → paste the code from the desktop's
Link-a-phone panel (`Cmd-V` pastes the Mac clipboard into the Simulator).

## Troubleshooting

- **"Could not detect a LAN IPv4"** — Wi-Fi is on an unusual interface; pass
  `ARGS="--lan-ip 192.168.x.y"`.
- **Phone shows "Couldn't reach the sign-in service"** — Mac firewall is
  blocking inbound `bun`/`node`, or phone and Mac are on isolated Wi-Fi
  networks (guest SSIDs often block peer traffic). From another LAN machine:

  ```bash
  curl http://<lan-ip>:<authn-port>/
  ```

- **White screen on launch** — the lane's Vite server isn't running (the app
  loads its bundle from it); re-run `make dev-ios-device`.
- **Codes always "invalid or expired"** — codes are single-use with a 60 s
  TTL; scan the QR currently on screen, not a screenshot.
