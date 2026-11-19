/**
 * A minimal `agent.gui.listHarnesses` row for the per-id version-line tests
 * (`command-code-lines`, `cline-lines`).
 *
 * The frozen schemas these tests parse against differ only in the harness-id
 * enum, so the row carries nothing else interesting: every other field is the
 * cheapest value the live schema accepts.
 */
export function guiHarnessRowForLineTest(id: string) {
  return {
    id,
    label: id,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ],
  };
}
