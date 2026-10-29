/**
 * The build-time switch for the features this release does not ship:
 * sandboxes, environments and bots, in the code every client shares. With it
 * off the clients speak to the cloud and to a host as the release before the
 * features did: the identity fetch advertises no environment-carrying user
 * record and no invitation header, the host registry read asks for no sandbox
 * or team rows, and a request routed to the selected host goes to its target.
 *
 * Each gate is written so that deleting the `UNRELEASED_FEATURES_ENABLED`
 * term restores the original expression. Retiring the switch is a grep for
 * its name across every service. Stamped per build like the other clients'
 * copies (`clients/scripts/set-unreleased-features.cjs`).
 */
export const UNRELEASED_FEATURES_ENABLED: boolean = true;
