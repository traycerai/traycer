/**
 * The build-time switch for the features this release does not ship:
 * sandboxes, environments and bots. With it off the app mounts none of their
 * entry points: no bots band or Tracy entry, no environment picker or
 * sandbox rows in Settings, no New sandbox rows in a host picker, and their
 * routes redirect. The rest of the app runs as it did before the features
 * existed.
 *
 * Each gate is written so that deleting the `UNRELEASED_FEATURES_ENABLED`
 * term restores the original expression. Retiring the switch is a grep for
 * its name across every service.
 */
export const UNRELEASED_FEATURES_ENABLED: boolean = false;
