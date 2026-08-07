# AGENTS.md

Read this together with the repository root guide and
`clients/gui-app/AGENTS.md`.

## Purpose and boundary

`clients/mobile` is a thin Capacitor shell around the shared `gui-app`, with an
iOS and an Android platform. The current milestone is intentionally
emulator/Simulator-only.

This workspace may:

- mount `<TraycerApp />` with a mobile `IRunnerHost`;
- bridge browser, secure-storage, and native HTTP capabilities;
- consume an existing `make dev-gui-app` or `make dev-desktop` slot;
- adapt the shared GUI for phone safe areas and touch layout in mobile-only
  CSS.

It must not change or duplicate the RPC protocol, host lifecycle, authn
service, cloud UI, remote-host service, or root `dev-desktop` allocator.
Sentry, deep-link auth callbacks, store signing, and release automation are
outside the current milestone. OS push (permission, APNs/FCM token
registration, tap-to-open) is IN the milestone — see `src/push-registration.ts`;
the registration flow is one platform-agnostic controller, and the platform
only decides the `(platform, environment)` pair (`pushRegistrationTarget`).

## Host and auth model

- Mobile has no bundled local host. `onLocalHostChange` synchronously emits
  `null` and never transitions.
- `vite.config.ts` reads the selected existing slot at
  `~/.traycer/host/dev-runs/<slot>/pid.json`, validates it, and injects exactly
  one `kind: "remote"` directory entry through the GUI's existing
  `RemoteHostFetcher` seam.
- Dev auth/cloud URLs are explicit launcher inputs. Never hard-code ports or
  derive the root allocator's port algorithm here.
- Interactive sign-in is current OAuth device flow. The callback signal is
  payload-free and sign-in must complete by polling even if no return signal is
  delivered.
- Capacitor's native HTTP patch keeps auth requests out of WKWebView CORS.
- The shared device-auth client supports `"cli"`, `"desktop"`, and `"mobile"`;
  this shell signs in as `"mobile"` (authn shows mobile-specific approval copy
  and the session lists as a mobile device).
- Push tokens register against authn's `/api/v3/user/push-tokens` bound to the
  login session. Sign-out unregisters via `POST .../remove` and that call is
  the primary cleanup — plain sign-out is local-only and revokes nothing, so a
  failed remove lingers deliverable until the session family is revoked
  (sessions panel), the token rebinds, or authn's reaper collects it after the
  family's sessions expire. Explicit session revocation does cascade the row
  away server-side.

## Important files

- `src/mobile-runner-host.ts` — current `IRunnerHost`, device-flow controller,
  and native secure token storage.
- `src/push-registration.ts` — OS push lifecycle: permission, provider-token
  registration following the token store, and the tap→activation relay the
  GUI consumes through `notifications.onClick` (cold-start taps buffered).
- `src/web/main.tsx` — mounts the shared GUI and supplies the one-host fetcher.
- `src/web/index.css` — Tailwind entrypoint; its `@source` for `gui-app` is
  required or shared utility classes disappear from the mobile bundle.
- `src/web/mobile.css` — mobile-only safe-area/responsive overrides.
- `scripts/dev-run.ts` — slot resolution, `run.json` reading, and the Capacitor
  live-reload handoff, shared by both launchers so they cannot drift.
- `scripts/dev-ios.ts` / `scripts/dev-android.ts` — live-reload launchers that
  consume the existing slot. Android additionally opens `adb reverse` tunnels.
- `ios/` — generated Capacitor 8 Swift Package Manager project.
- `android/` — generated Capacitor 8 Gradle project.

For both native projects: keep the generated structure authoritative and
reapply only small reviewed native deltas. The current Android deltas are
exactly four — `POST_NOTIFICATIONS` and the activity's
`windowSoftInputMode="adjustResize"` in `app/src/main/AndroidManifest.xml`, the
debug-only cleartext overlay under `app/src/debug/`, and the tracked
`app/google-services.json.example`.

Run `bun run --cwd clients/mobile sync:android` before invoking `./gradlew`
directly. `capacitor.settings.gradle` is tracked but embeds bun install-layout
hashes (`node_modules/.bun/@capacitor+android@8.4.2+<hash>/…`) that shift with
any dependency change, and `settings.gradle` includes
`capacitor-cordova-android-plugins/`, which is gitignored — so a fresh clone or
a post-dep-bump tree fails Gradle confusingly until a sync regenerates both.
`cap run`/`cap build` sync first and are unaffected.

## Commands

From the repository root:

```bash
bun run --cwd clients/mobile compile
bun run --cwd clients/mobile test
bun run --cwd clients/mobile build:web
bun run --cwd clients/mobile sync:ios      # sync:android
bun run --cwd clients/mobile dev:ios -- \
  --slot <slot>
bun run --cwd clients/mobile dev:android -- \
  --slot <slot>
```

In the internal repository, `make dev-gui-app` owns the per-worktree GUI App
Vite server and dev host without starting Electron. `make dev-ios` and
`make dev-android` resolve that worktree's slot, then the matching launcher
reads the server URL from `run.json`, builds/installs the native app, creates
ignored web assets when they are absent, and connects Capacitor live reload to
it. React/CSS changes reload without reinstalling; Capacitor config, plugin,
Swift/Java, Gradle, or Xcode-project changes require a native rebuild.
`make dev-desktop` remains compatible when Electron testing is also needed.

The workspace scripts above are the escape hatch when an explicit slot is
needed; the Makefile targets are the normal entry points.

## Android specifics

- **Loopback.** The emulator's `127.0.0.1` is its own, not the Mac's, so
  `dev-android.ts` runs `adb reverse` for every port the slot publishes
  (authn, cloud UI, GUI App, and the host's RPC port read from `pid.json`).
  That is what lets the single set of `http://localhost:<port>` URLs baked by
  `vite.config.ts` work unchanged on both platforms — there is deliberately no
  Android-only URL rewriting and no `10.0.2.2` in application code. Re-run the
  launcher after a host restart so the new RPC port gets a tunnel.
- **Scheme.** `androidScheme` is `http` to match `iosScheme` — parity is the
  reason, and the only one; the loopback WebSocket guard accepts `http:` and
  `https:` on loopback identically. Live reload overrides the document origin
  anyway, so this governs only the packaged build. Settled early because
  changing it after an install exists wipes origin-scoped storage. Debug builds
  carry a loopback-scoped cleartext exemption; release builds do not.
- **Firebase config is ops.** `android/app/google-services.json` is gitignored
  and normally absent. `android/app/build.gradle` (Capacitor's own template
  code) applies the `com.google.gms.google-services` plugin only when the file
  is readable, so **the absence is the supported default**: the build succeeds,
  Firebase never initializes, `PushNotifications.register()` rejects, and
  `src/push-registration.ts` logs and swallows it. See
  `android/app/google-services.json.example` for the shape — do not rename it
  with its placeholder values in place, which would fail later and less
  clearly.
- **Notification permission.** `POST_NOTIFICATIONS` must be declared in the app
  manifest; the plugin's library manifest does not contribute it, and without
  it Android denies the request without ever showing the dialog. Below API 33
  the plugin reports `granted` and no prompt is issued.

### Verification status

Emulator-verified: **nothing**. This machine has an Android SDK but no AVD
system image, and the loop was never run end to end. Treat the following as
open:

- app launch, live reload, and `adb reverse` against a live `make dev-gui-app`;
- the host WebSocket accepting the `http://localhost` WebView origin in
  practice (reasoned from `loopback-upgrade-guard.ts`, not observed);
- the Android 13+ permission dialog;
- **the packaged-build scheme choice** — `androidScheme` only takes effect
  without live reload, and no packaged build has been run. Whether such a build
  loads its `http://localhost` assets with cleartext disabled is likewise
  unconfirmed;
- **soft-keyboard behavior** — `adjustResize` is set so the `h-dvh` shell and
  terminal key bar track the visible area, but that has never been seen on a
  device. The Capacitor Keyboard plugin's `resize`/`autoBackdropColor` options
  are iOS-only, so Android has no equivalent knob to fall back on;
- any real FCM token or push delivery (ops-gated regardless).

Gradle-verified on this machine: `assembleDebug` and `assembleRelease` both
succeed with no `google-services.json`; the merged debug manifest carries
`POST_NOTIFICATIONS`, the network-security config, and the plugin's FCM
service; the merged release manifest carries the permission but not the
cleartext exemption; and `processDebugGoogleServices` exists only when the
config file is present.

## Working rules

- Import shared contracts; do not redefine them.
- Keep unsupported mobile capabilities as explicit no-ops/nulls matching
  `IRunnerHost`.
- Keep the production mobile code free of release/telemetry scaffolding until
  those milestones are explicitly approved. (Push was approved with the
  notifications milestone and lives in `src/push-registration.ts`; the Android
  platform was approved with it.)
- Platform differences belong in the native projects, the launcher scripts, or
  `pushRegistrationTarget` — not in branching inside the shared GUI.
- Follow root type-safety rules: no `any`, unsafe assertions, optional function
  parameters, or default parameter values.
- Tests live under `__tests__/` and mock native plugins at the package boundary.
