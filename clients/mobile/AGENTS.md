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

## Layout invariants

**One layout, every device.** The installed app is a phone-layout product on
iPad as much as iPhone — by product decision, not by measurement. Three pieces
hold it, and all three have to move together or the app half-changes shell:

- `src/web/main.tsx` calls `setPhoneLayoutOnly(true)` **unconditionally**, and
  `useIsMobileViewport()` reads that before it consults a media query. It is
  deliberately not `isMobileApp()`: this same bundle is served to a plain
  browser tab as the launcher's `gui-app` stream, where the native flag is
  false, so keying layout off it would put that tab on the desktop layout
  against phone CSS. `isMobileApp()` stays product-only (store copy, the
  single-composer draft model) and decides no layout anywhere.
- `src/web/index.css` pushes every Tailwind breakpoint out of reach, so `md:`
  and `lg:` utilities cannot paint desktop controls over the phone shell at
  tablet widths. The comment there explains why it is a sentinel value and not
  `--breakpoint-*: initial`. **Raw `@media` rules outside Tailwind do not get
  this for free** — a hand-written `max-width: 767px` tier is phone styling
  that silently stops applying on a tablet running the phone shell. Either key
  it on the resolved layout, or override it here in `mobile.css`, which is what
  the first-task coachmark's type scale does.
- Both platforms are portrait-locked on tablets as well as phones. iOS:
  `UISupportedInterfaceOrientations~ipad` in **both** `Info.plist` and
  `Info-Dev.plist` (Debug builds use the latter, so they are what the lock is
  actually exercised on), plus `UIRequiresFullScreen`, which Apple requires of
  an app that drops an orientation. Treat that key as compatibility mode, not
  a guarantee: Stage Manager and iPadOS 26 windowing still scale the app, and
  it is deprecated against the iOS 27 SDK. Android:
  `android:screenOrientation` on `MainActivity`, plus the
  `PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY` opt-out, without which
  targetSdk 36 ignores that lock on anything sw600dp or larger. The opt-out
  disappears at targetSdk 37 and the comment in the manifest says what to do
  then (delete both; the phone layout handles free rotation).

**Known limitation — the dev browser tab, 768–1024px, onboarding acts only.**
This entry is also served to a plain browser tab (the launcher's `gui-app`
stream), where `isMobileApp()` is false, so `OnboardingPage` mounts
`OnboardingActs` rather than the welcome run. The hook says phone at every
width there, but four of upstream's onboarding stylesheets — `onboarding.css`,
`onboarding-import.css`, `onboarding-host-picker.css`, `onboarding-agents.css`
— still gate their phone geometry behind a hand-written `max-width: 767px`,
which the breakpoint sentinel cannot reach. Widen that tab past 768 and the
acts render phone JS in desktop geometry: provider grid, 40px Continue.

**It cannot happen in the installed app**, which never reaches those acts. It
is left unfixed on purpose: the only two remedies are duplicating upstream's
tiers here or rewriting upstream CSS, and neither is worth doing to a dev-only
surface. The real fix belongs upstream and is small — the acts shell already
carries `data-phone` from `useIsMobileViewport()` (`onboarding-page.tsx`), and
`onboarding.css` already keys one rule on it, so those tiers want
`[data-phone="true"]` instead of a width. Raise it there rather than patching
around it here.

## Host and auth invariants

- No bundled local host — `onLocalHostChange` emits `null`, never transitions.
  `vite.config.ts` injects exactly one `kind: "remote"` directory entry from
  the selected dev slot; never hard-code ports.
- Sign-in is the OAuth device flow. The approval page opens in the in-app
  auth sheet (`src/auth-sheet.ts`: ASWebAuthenticationSession / a Custom Tab,
  sharing the browser's cookies; sign-in only, every other link goes to the
  browser app). The return signal is payload-free (the foreground-resume edge,
  the sheet's completion, or the return link's `appUrlOpen`, all via
  `IRunnerHost.onAuthCallback`); polling must complete sign-in even with no
  signal. The return scheme comes from the
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
- `src/sentry.ts` — crash-reporting options; `main.tsx` inits `@sentry/browser`
  with them first thing. The DSN is `TRAYCER_MOBILE_SENTRY_DSN` at build time
  (`""` = off, the local default); sourcemaps are emitted only when
  `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` are all exported, and
  the upload plugin deletes them before `cap sync` copies `dist/web` into the
  app. Every event and breadcrumb passes the shared scrub
  (`clients/shared/platform/sentry-scrub.ts`, the same hooks the desktop
  renderer installs) - not optional, the link-login code rides in a query
  string. `@sentry/browser` and NOT `@sentry/capacitor`, deliberately - the
  header comment in `src/sentry.ts` has the version-carrier reason. WebView
  layer only; native crashes are not reported yet.
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
