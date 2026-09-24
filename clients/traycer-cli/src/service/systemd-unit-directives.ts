import { SYSTEMD_TIMEOUT_STOP_SECONDS } from "./spawn-edge-bounds";

/**
 * Every `[Service]` directive `buildUnit` (`platforms/linux.ts`) writes, in
 * emission order, with the fixed value it writes - `null` where the value is
 * per-install (`SyslogIdentifier` is the label id, `ExecStart` the CLI
 * invocation).
 *
 * ONE list on purpose, because the host mirrors it: its unit reader
 * (`recoverFromSystemdUnit`, `traycer-host/src/domain/update/cli-invocation/
 * legacy-linux.ts`) admits only the keys in `EMITTED_SERVICE_KEYS` and the
 * values in `EMITTED_SERVICE_VALUES`, and returns null for any unit carrying
 * anything else - so a directive added or a value changed here is a unit the
 * host can no longer recover the CLI invocation from until it admits it too.
 * Nothing about that needs an edit to `linux.ts`: `TimeoutStopSec` is derived
 * from the host's own shutdown constants, so retuning the host watchdog alone
 * changes what is emitted.
 *
 * Two tests hold the two halves together:
 *   - `platforms/__tests__/linux.test.ts` parses the `[Service]` section
 *     `buildSystemdUnit` actually writes and pins it to this object, keys in
 *     order and every fixed value;
 *   - the host imports this object from the pinned submodule and asserts its
 *     reader admits every key and every fixed value, so the pin bump that
 *     carries a change here is red until the host admits it.
 *
 * A LEAF sibling of `spawn-edge-bounds.ts`, and pinned as one
 * (`__tests__/spawn-edge-bounds-leaf.test.ts`): that module is its only
 * import. `linux.ts`'s own graph is hundreds of modules and needs aliases the
 * host's test config does not carry; this one needs only protocol's
 * `host/lifecycle-constants`, which the host already resolves.
 */
export const SYSTEMD_UNIT_SERVICE_DIRECTIVES = {
  Type: "simple",
  SyslogIdentifier: null,
  ExecStart: null,
  OOMPolicy: "continue",
  Restart: "on-failure",
  RestartSec: "5",
  TimeoutStopSec: `${SYSTEMD_TIMEOUT_STOP_SECONDS}`,
} as const satisfies Readonly<Record<string, string | null>>;
