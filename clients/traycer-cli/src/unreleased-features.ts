/**
 * The build-time switch for the features this release does not ship:
 * sandboxes, environments and bots. With it off the `traycer bot` commands
 * are not registered. The rest of the CLI runs as it did before the
 * features existed.
 *
 * Each gate is written so that deleting the `UNRELEASED_FEATURES_ENABLED`
 * term restores the original expression. Retiring the switch is a grep for
 * its name across every service.
 */
export const UNRELEASED_FEATURES_ENABLED: boolean = true;
