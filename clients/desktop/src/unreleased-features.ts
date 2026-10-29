/**
 * The build-time switch for the features this release does not ship:
 * sandboxes, environments and bots, in the desktop's main process. With it
 * off the main process registers no sandbox, team, secret or grant IPC and
 * attaches no environment context to a support report, as the release before
 * the features did; the renderer it hosts carries the gui-app's own copy.
 *
 * Each gate is written so that deleting the `UNRELEASED_FEATURES_ENABLED`
 * term restores the original expression. Retiring the switch is a grep for
 * its name across every service. Stamped per build by
 * `scripts/set-deploy-target.cjs` with the gui-app's and the shared copy.
 */
export const UNRELEASED_FEATURES_ENABLED: boolean = true;
