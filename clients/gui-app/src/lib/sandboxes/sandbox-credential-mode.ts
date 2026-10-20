import type { GuiHarnessSandboxCredentialMode } from "@traycer/protocol/host/agent/gui/unary-schemas";

/**
 * What the harness picker says about a coding CLI on a sandbox host, from the
 * row's `sandboxCredentialMode` (`agent.gui.listHarnesses@10.1`).
 *
 * `null` for a row with no mode: a personal host, or a sandbox host from
 * before the field, where the picker says what it always said. A CLI that is
 * not offered on sandboxes at all is absent from the list, so there is no line
 * for it.
 */
export interface SandboxCredentialLine {
  readonly tone: "plain" | "caution" | "unavailable";
  readonly text: string;
}

export function sandboxCredentialLine(
  mode: GuiHarnessSandboxCredentialMode | null | undefined,
  note: string | null | undefined,
): SandboxCredentialLine | null {
  switch (mode) {
    case "placeholder":
      return {
        tone: "plain",
        text: "On this sandbox its credential stays with Traycer: agents can use it, never read it",
      };
    case "process-scoped":
      return {
        tone: "caution",
        text: "Runs with its own credential on this sandbox, readable by agents",
      };
    case "unsupported": {
      const mechanism = note === null || note === undefined ? "" : note.trim();
      return {
        tone: "unavailable",
        text:
          mechanism.length === 0
            ? "Not available on sandboxes"
            : `Not available on sandboxes: ${mechanism}`,
      };
    }
    case null:
    case undefined:
      return null;
  }
}
