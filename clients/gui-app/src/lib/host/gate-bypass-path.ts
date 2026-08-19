/**
 * URL prefix for the routes that work without a running host.
 *
 * Settings needs no host - the Shell page edits SQLite through the CLI
 * subprocess, the Service page talks to launchd/systemd directly - so it is
 * the escape hatch out of a wedged startup: edit the shell args, restart the
 * host, watch the bootstrap log refill.
 *
 * Two consumers, deliberately reading ONE constant: `DefaultHostReadyGate`
 * (which must not block the escape hatch, since its own "Configure shell"
 * action navigates here) and the window narrator (which steps aside on the
 * same routes, since its "Open settings" action is what sends a user here in
 * the first place). Gating either on a ready host would put the recovery
 * behind the failure it exists to fix.
 *
 * It lived in `local-host-gate.tsx` until that file's dead wrappers were
 * deleted (redesign P3.4). It was never about the gate - it is a routing fact
 * - so it outlived the component that first needed it.
 */
export const GATE_BYPASS_PATH_PREFIX = "/settings";
