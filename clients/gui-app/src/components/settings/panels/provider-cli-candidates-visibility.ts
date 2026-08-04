import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";

/**
 * Providers with no CLI-binary concept at all (API-key-only, GUI-driven), for
 * which `ProviderCliCandidatesSection` renders nothing.
 *
 * Lives in its own module rather than beside that component because it is also
 * the emptiness test for the `general` ("CLI & Args") tab in
 * `providers-settings-panel.tsx`: the candidates section and the
 * terminal-agent args field are that tab's ENTIRE body, and the args field
 * self-gates on the `tui` mode these same providers never advertise. So a
 * hidden candidate table means an empty tab, and the panel drops it from the
 * tab bar rather than listing one that renders nothing.
 */
export function hidesCliCandidates(
  providerId: ProviderCliState["providerId"],
): boolean {
  return providerId === "cursor" || providerId === "amp";
}
