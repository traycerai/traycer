/**
 * Import surface for `clients/*` workspaces: same-package relatives,
 * `@traycer-clients/*`, `@traycer/protocol/*` (and TS path aliases to those),
 * or third-party packages. Blocks other monorepo scopes such as
 * `packages/common` (`@traycerai/*`) and non-protocol `@traycer/*` paths.
 *
 * Wire via `@typescript-eslint/no-restricted-imports`:
 * `["error", traycerClientsImportBoundaryRestrictions]`.
 */
import { protocolBoundaryRestrictions } from "./protocol-boundary-rules.mjs";

export const traycerClientsImportBoundaryRestrictions = {
  patterns: [
    ...protocolBoundaryRestrictions.patterns,
    {
      group: ["@traycerai/**"],
      message:
        "Client packages must not import `@traycerai/*` (for example packages/common). " +
        "Use `@traycer/protocol/*` or `@traycer-clients/*` instead.",
    },
    {
      group: ["@traycer/**", "!@traycer/protocol", "!@traycer/protocol/**"],
      message:
        "Client packages may only import `@traycer` through `@traycer/protocol/*`. " +
        "Use the protocol path alias or `@traycer-clients/*` for other shared code.",
    },
  ],
};
