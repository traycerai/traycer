# Traycer mobile client

This workspace is the Capacitor adapter around the shared Traycer GUI App. It
does not start, discover, or modify a host. In the internal repository,
`make dev-gui-app` runs the GUI App web server and host as first-class
per-worktree services without Electron; this adapter consumes that server and
the selected slot metadata under:

`~/.traycer/host/dev-runs/<slot>/`

## Live-reload development

From the internal repository root, start the shared stack and boot exactly one
iOS Simulator:

```bash
make dev-gui-app
```

Then launch the native shell from a second terminal:

```bash
make dev-ios
```

The root command resolves the current worktree's slot through the existing
orchestrator. The launcher reads the allocated `gui-app` URL from that slot's
`run.json`,
creates the ignored local web bundle when a clean checkout does not have one,
builds/installs the native app, and connects Capacitor live reload to the same
Vite server used for ordinary browser testing. Web/React/CSS edits reload
without reinstalling. Capacitor config, plugin, Swift, signing, or Xcode-project
changes still require a native rebuild. Build products and per-device Xcode
state stay ignored and are recreated locally.

### Android

Boot exactly one Android emulator instead (`adb devices` should list one), then
from the same place:

```bash
make dev-android
```

It consumes the same slot and the same `run.json` through the same launcher
plumbing. The one extra step is `adb reverse`: the emulator's loopback is its
own, so every port the slot publishes is tunnelled back to this machine and the
baked `http://localhost:<port>` URLs resolve unchanged. Re-run it after
restarting the dev host, which reallocates its RPC port — the launcher warns if
it cannot read that port.

Run `bun run --cwd clients/mobile sync:android` before invoking `./gradlew`
directly: the tracked Gradle files reference bun install paths and a gitignored
plugin directory, both of which a sync regenerates.

Push on Android needs an ops-provisioned
`clients/mobile/android/app/google-services.json` (gitignored; see the tracked
`.example` beside it for the shape). Without it the build still succeeds and
the app runs — it just never obtains an FCM token.

The Android platform has **not** been run in an emulator yet; see the
verification status in `AGENTS.md` for what that leaves open.

### Explicit slots

The direct workspace commands remain available when an explicit slot is needed:

```bash
bun run --cwd clients/mobile dev:ios -- --slot <slot>
bun run --cwd clients/mobile dev:android -- --slot <slot>
```

The dev flow above is emulator/Simulator-only because the dev host binds to
Mac loopback. A physical Android device attached over USB is closer —
`adb reverse` works there too — but is untested.

## Shipped builds (real devices via remote hosts)

`TRAYCER_MOBILE_ENV=staging|production` bakes a deployed backend set instead
of the loopback scaffolding. Such a bundle carries no dev host: discovery goes
through the shared gui-app default fetcher (`GET /api/v3/hosts`), and the app
connects to the user's enrolled hosts through the relay — the same production
path as the desktop shell.

```bash
bun run --cwd clients/mobile sync:ios:staging
bun run --cwd clients/mobile open:ios   # set your team, run on a device
```

Staging is the only connectable target today (the production relay has no
release yet). The signed-in account must be allowed to use remote hosts
(server-side plan gate), and a host must be enrolled against the staging
cloud — from the internal repo, `make remote-host-staging` or a staging-target
host on your own machine.
