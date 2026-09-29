# Cold boot relay capture on an iPhone

This procedure measures incoming relay payloads on the installed staging app.
It does not assign the earlier 34.5 MB field observation; that boot has no
method-level capture. Keep the original observation separate from every new
run.

## Build and state

1. Use a **Traycer Staging** TestFlight build whose internal-repo submodule pin
   contains this OSS change. The internal `Release Mobile - iOS` staging lane
   runs `TRAYCER_MOBILE_ENV=staging bun run sync:ios` in
   `traycer/clients/mobile`, then archives/uploads the native app stamped
   `ai.traycer.app.ios.staging`. It is reached by a `mobile-staging-v<semver>`
   tag on the internal `mobile-app` branch or the approved on-demand staging
   auto workflow with `rehearsal` unchecked. Record the TestFlight
   version/build number, the internal repin commit and the OSS commit. An OSS
   PR build or a web browser run is not an installed-phone measurement.
   Release/tag approval is handled through the internal mobile runbook; this
   procedure does not publish a build.
2. Keep the same signed-in staging account, enrolled device host, landing route
   and live draft set between paired runs. Record whether the visible draft has
   images and whether its owner host is online. Do not copy account identifiers
   into the result.
3. In Safari Web Inspector for the phone's app WebView, find the origin's
   IndexedDB database `traycer-gui-app:default:landing-images`, object store
   `bytes`. Record only its **entry count** before each run, never its keys or
   values. For the empty-store arm, clear only this `bytes` object store and
   confirm count zero. Do not clear the origin, localStorage, secure tokens or
   sign-in state. A relaunch resets the in-memory image cache; a process kill
   alone does not prove the persistent byte store is empty. Run a warm-store
   arm immediately after the empty-store run without clearing it; record its
   new entry count before that reload.

## Enable and sample the counter

With the app open in Web Inspector, set the fixed diagnostic flag before
relaunching. Use `localStorage` for an app/WebView process relaunch; unlike
`sessionStorage`, it survives that relaunch while this origin's data remains
intact. For a same-document reload only, `sessionStorage` is sufficient. This
flag contains no account or credential data.

```js
localStorage.setItem("traycer:remote-traffic-debug", "1");
location.reload();
```

The flag is read when each client remote session is constructed. It is off by
default. This procedure deliberately clears only the image-byte store. If iOS
purges the entire origin, it also erases the debug flag; that first post-purge
launch cannot be captured with this storage opt-in and requires a separately
instrumented build. Once the new app page is running, the console reader is
`globalThis.__traycerRemoteTraffic.snapshot()`. It returns one in-memory row
per live captured remote session (up to 32), with per-stream method, stream ID,
safe `epic`/`chat` UUIDs, first/last receive times, incoming ciphertext bytes,
pre-decompression mux bytes, frame/compressed-frame counts, an incomplete
marker and the number of connection drops the stream stayed open across. The
session-level `reconnects` counts relay WebSocket legs that opened and then
dropped into recovery, not dials that never opened or caller closes. It
contains no payload body.
Stream times are milliseconds relative to that session's `startedAt`; the
stopwatch records navigation-relative paint and settled times.

Start a screen recording or stopwatch at navigation/relaunch. At the **first
visible restored task tile**, **visible landing composer**, or when the **first
20 History rows have loaded** for a History landing, immediately evaluate and
save the snapshot below. Record the elapsed time and the visible landmark; a manual console sample can lag paint,
so report that lag when comparing runs. Take a second snapshot at 40 seconds
for warm cache and 75 seconds for empty cache, measured from the same start.
Do not tap a hidden draft or drawer before the settled sample. Record whether
the visible draft's idle prefetch ran after paint; its bytes belong in the
settled total.

```js
globalThis.__traycerRemoteTraffic.snapshot();
```

For each snapshot, keep `receivedBytes` and `receivedFrames` per capture
session, then aggregate stream ciphertext bytes by method. The ledger should
reconcile **for each session**, in bytes and frames:

```text
received = sum(stream ciphertext) + relayText + noiseHandshake + unclassifiedBinary
```

Report nonzero unclassified binary as residual, rather than assigning it to a
method. If `truncatedStreamRegistrations` is nonzero, the 1,024-row cap has
left later streams in that residual; mark the method breakdown incomplete and
repeat in a clean app session. Mux bytes are measured before application decompression; ciphertext
bytes are the incoming Noise packet payloads. The counter excludes outbound
traffic, WebSocket/TLS/TCP framing, HTTP/authn, and JavaScript assets. The
settled interval is a sampling window, not a claim that first paint took that
long. Check `globalThis.__traycerRemoteTraffic.droppedSessions()` too. If it
is nonzero, the 32-session reader cap dropped older sessions: mark the total
incomplete and repeat in a clean app session. A session that closes leaves the
snapshot with its rows, including one opened and closed between the two
samples. Save `globalThis.__traycerRemoteTraffic.closedSessions()` with each
snapshot: it counts the sessions closed since the page loaded and the
`receivedBytes` and `receivedFrames` their rows held. If its `receivedBytes`
is nonzero, the per-session ledger no longer holds those bytes: add them to the
total as closed-session traffic and mark the method breakdown incomplete.
`captureSession` IDs are assigned in order and never reused, so match sessions
across the two snapshots by that ID.

For an image-heavy submit check, use a visible draft with several images, an
empty local byte store and an offline **owner** host while this device still
has its own reachable relay host. Measure from Send tap to image resolution or
explicit refusal, and note the number of image RPCs and their bytes. A
hash-only image must not be counted as a successful submit. Do not mutate the
test draft's image set between paired measurements.

## Privacy and finish

Export only method names, stream numbers, byte/frame counts, timing,
incomplete/reconnect flags and safe `epic`/`chat` UUIDs. Do not collect user,
account or organization IDs, refs, hashes, titles, paths, payloads, headers,
credentials, raw console errors or their messages. Avoid a Web Inspector
network HAR: it can contain credentials and payloads. Clear the flag after the
capture:

```js
localStorage.removeItem("traycer:remote-traffic-debug");
sessionStorage.removeItem("traycer:remote-traffic-debug");
location.reload();
```
