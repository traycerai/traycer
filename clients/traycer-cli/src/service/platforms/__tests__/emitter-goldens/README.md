# Emitter goldens

Byte-for-byte pins of what the three platform controllers' install emitters
write, for one fixed label and one fixed CLI invocation. `traycer-host`'s
`src/domain/update/cli-invocation/legacy-{linux,macos,windows}.ts` readers
recover the CLI invocation from exactly this kind of content, and read these
same files (through the pinned `traycer` submodule) to prove it. The OSS
tests (`../emitter-goldens.test.ts` for Linux/macOS,
`../emitter-goldens-windows.test.ts` for Windows) pin the emitter output; the
host test (`cli-invocation/__tests__/emitter-goldens.test.ts` in
traycer-internal) pins the reader against
the same bytes. A change to an emitter's output is therefore red on both
sides until the host reader is updated to match.

## Fixed inputs

- **Label**: `serviceLabelFor("production")`, which is
  `{ id: "ai.traycer.host", displayName: "Traycer Host", environment: "production", devSlot: null }`.
- **CLI invocation**: the packaged form, `{ command: <cli>, args: [] }`.
  - POSIX (Linux unit, macOS plist/launcher):
    `/home/golden-user/.traycer/cli/bin/traycer`
  - Windows (Task XML, VBS launcher):
    `C:\Users\golden-user\.traycer\cli\bin\traycer.exe`
- **Placeholder home**: `/home/golden-user` (POSIX) / `C:\Users\golden-user`
  (Windows) - every home-derived path an emitter embeds (the macOS launcher
  path baked into the plist, the Windows launcher path derived from
  `cliInstallHomeDir`) comes from this placeholder, via a mocked
  `node:os.homedir()`, never from the machine that generated or runs the
  test.
- **Other stubbed environment**: `PATH=/home/golden-user/bin` (macOS plist's
  baked `$PATH`), `USERDOMAIN=""` / `USERNAME=golden-user` (Windows Task XML
  `<UserId>`), `SystemRoot=SYSTEMROOT=C:\Windows` (Windows Task XML's
  `wscript.exe` path).

## Files

| File                       | Emitter                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `systemd-unit.service`     | `buildSystemdUnit` (`../linux.ts`)                         |
| `launch-agent.plist`       | `buildLaunchAgentPlist` (`../macos.ts`)                    |
| `host-start-launcher.sh`   | `buildHostStartLauncherScript` (`../host-start-script.ts`) |
| `task.xml`                 | `buildScheduledTaskXml` (`../windows.ts`)                  |
| `hidden-host-launcher.vbs` | `buildWindowsHiddenHostLauncher` (`../windows.ts`)         |

## Regenerating

Never hand-edit these files. Regenerate from the emitter: temporarily write
the emitter's output to the file (a throwaway `writeFileSync` in a scratch
test, deleted after use, never committed), diff against the checked-in
version to confirm the change is the one you intended, then commit the new
golden alongside the production change and the corresponding host-side pin
update.

## Two test files, deliberately - and why

`task.xml` and `hidden-host-launcher.vbs` are byte-identical regardless of
the host OS the two emitter functions themselves run on - neither
`buildScheduledTaskXml` nor `buildWindowsHiddenHostLauncher` branches on
`process.platform`. But `buildScheduledTaskXml`'s launcher path
(`hiddenHostLauncherPath` -> `cliInstallHomeDir` -> protocol's
`installation.ts` -> `join(homedir(), ".traycer", "cli")`) goes through
`node:path`'s `join`, which IS platform-dependent: POSIX semantics produce
`/`-separated paths, win32 semantics produce `\`-separated ones - and a real
Windows CLI writes the latter.

So Windows gets its own file, `../emitter-goldens-windows.test.ts`, which
mocks `node:path`'s top-level exports to `path.win32` (and `node:os.homedir()`
to the Windows placeholder home) so the goldens here are the bytes a REAL
Windows machine would write - not an artifact of whatever OS generated or
runs the test. `../emitter-goldens.test.ts` (Linux, macOS) intentionally does
NOT mock `node:path`, so those two stay on this suite's native POSIX
semantics. Forcing win32 semantics for the whole suite would make the
Linux/macOS goldens wrong instead.

One trap when generating the Windows goldens: `node:path`'s mocked top-level
exports must never be used for the TEST's OWN file-system bookkeeping
(locating/reading/writing the golden files under this directory) - only for
what the emitter itself builds internally. `emitter-goldens-windows.test.ts`
imports `{ posix }` from the (mocked) `"node:path"` module explicitly for
that - the mock passes `posix` through unmodified - rather than the
win32-flavoured top-level `join`/`dirname`, which would hand a
backslash-joined string to `readFileSync`/`writeFileSync` on a POSIX host and
silently miss this directory.
