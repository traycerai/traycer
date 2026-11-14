import { describe, expect, it } from "vitest";
import { tuiHarnessIdSchema as hostTuiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { tuiHarnessIdSchema as persistedTuiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";

/**
 * The TUI harness id set lives in two places — the host/wire schema
 * (`.extract()` from the canonical harness enum) and the persisted epic
 * schema (`z.enum`). They describe the same concept (which ids are valid TUI
 * harnesses) and MUST stay identical: a value in one but not the other is a
 * record the wire accepts but persistence rejects, or vice versa. This guards
 * that drift when a new terminal harness is added.
 */
describe("TUI harness id enums stay in sync (host ↔ persistence)", () => {
  it("has identical option sets", () => {
    expect(hostTuiHarnessIdSchema.options).toEqual(
      persistedTuiHarnessIdSchema.options,
    );
  });
});
