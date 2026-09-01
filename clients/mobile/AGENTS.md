# AGENTS.md

Read with the repo root guide and `clients/gui-app/AGENTS.md`.

## Purpose and boundary

Thin Capacitor shell around the shared `gui-app` (iOS + Android). Dev loop is
Simulator/emulator against a Mac dev slot; shipped builds
(`TRAYCER_MOBILE_ENV=staging|production`) use remote-host discovery and go out
through TestFlight (internal repo `release-mobile-ios.yaml`; runbook in the
internal `docs/mobile/AGENTS.md`).

May: mount `<TraycerApp />` with a mobile `IRunnerHost`; bridge
browser/secure-storage/native-HTTP; adapt the shared GUI for safe areas and
touch in mobile-only CSS. Must not: change or duplicate the RPC protocol, host
lifecycle, authn, cloud UI, or the dev-slot allocator.

## Host and auth invariants

- No bundled local host — `onLocalHostChange` emits `null`, never transitions.
  `vite.config.ts` injects exactly one `kind: "remote"` directory entry from
  the selected dev slot; never hard-code ports.
- Sign-in is the OAuth device flow. The return signal is payload-free
  (`visibilitychange` resume edge via `IRunnerHost.onAuthCallback`); polling
  must complete sign-in even with no signal. The return scheme comes from the
  baked config (`returnScheme`): `traycer://` as checked into both native
  projects, re-stamped to `traycer-staging://` (with bundle id
  `ai.traycer.app.ios.staging`) by the iOS staging release lane so the two
  lanes coexist on one device.
- Native HTTP (CapacitorHttp) keeps auth requests out of WKWebView CORS — and
  replaces the transport User-Agent, so anything identifying the device must be
  self-reported in a request body, not read from headers.
- Signs in as the `"mobile"` client kind (`DEVICE_FLOW_CLIENT_ID` in
  `src/mobile-runner-host.ts`), which labels the session, keys the approval
  page's copy, and gates push-token registration. Requires an authn deployment
  that accepts `"mobile"` — a production app release must trail the production
  authn deploy (release checklist carries the probe).
- Push tokens bind to the login session (`/api/v3/user/push-tokens`); sign-out
  unregisters via `.../remove` — plain sign-out is local-only and revokes
  nothing server-side.

## Key files

- `src/mobile-runner-host.ts` — `IRunnerHost`, device flow, secure token store.
- `src/push-registration.ts` — push permission/registration/tap-relay,
  platform-agnostic; platform only picks `pushRegistrationTarget`. Also backs
  the `IRunnerHost.pushPermission` capability the Settings row reads.
- `src/web/main.tsx` — mounts the shared GUI.
- `src/web/index.css` — its `@source` for `gui-app` is required or shared
  utility classes vanish from the bundle. `mobile.css` — mobile-only overrides.
- `scripts/dev-run.ts` + `dev-ios.ts` / `dev-android.ts` — slot-consuming
  live-reload launchers (Android adds `adb reverse` tunnels).
- `ios/`, `android/` — generated Capacitor projects: keep the generated
  structure authoritative; reapply only small reviewed native deltas.

## Commands

```bash
bun run --cwd clients/mobile compile | test | build:web | sync:ios | sync:android
bun run --cwd clients/mobile dev:ios -- --slot <slot>      # dev:android
```

Normal entry points live in the internal repo: `make dev-gui-app` then
`make dev-ios` / `make dev-android` (resolve the worktree's slot, install,
connect live reload). React/CSS hot-reloads; native/config changes need a
rebuild. Run `sync:android` before invoking `./gradlew` directly — tracked
Gradle files embed install-layout hashes that go stale.

## Android notes

- `adb reverse` gives the emulator the Mac's `localhost` ports — no `10.0.2.2`
  anywhere in app code; re-run the launcher after a host restart.
- `androidScheme` is `http` for iOS parity; changing it after installs exist
  wipes origin-scoped storage.
- `google-services.json` is gitignored ops config; its absence is the supported
  default (build succeeds, push registration rejects and is swallowed).
- `POST_NOTIFICATIONS` must stay declared in the app manifest or Android 13+
  denies without ever prompting.

## Working rules

- Import shared contracts; never redefine them. Unsupported capabilities are
  explicit no-ops/nulls on `IRunnerHost`.
- Platform differences live in the native projects, launcher scripts, or
  `pushRegistrationTarget` — never as branches inside the shared GUI.
- Root type-safety rules apply. Tests under `__tests__/`, native plugins mocked
  at the package boundary.
