import { describe, expect, it } from "vitest";
import { providerEnvSubtitle } from "@/components/settings/panels/provider-env-subtitle";

describe("providerEnvSubtitle", () => {
  it("reaches every computer and sandbox for Personal", () => {
    expect(providerEnvSubtitle("Claude Code", { kind: "personal" })).toBe(
      "Set for Claude Code each time it starts, on every computer and sandbox running Personal. Unset removes a variable Claude Code would otherwise get from the shell.",
    );
  });

  it("reaches every host running the team for a team", () => {
    expect(
      providerEnvSubtitle("Claude Code", { kind: "team", teamName: "Acme" }),
    ).toBe(
      "Set for Claude Code each time it starts, on every host running Acme. Unset removes a variable Claude Code would otherwise get from the shell.",
    );
  });

  it("stays on this computer for a Local row", () => {
    expect(providerEnvSubtitle("Claude Code", { kind: "local" })).toBe(
      "Set for Claude Code each time it starts, on this computer only. Unset removes a variable Claude Code would otherwise get from the shell.",
    );
  });
});
