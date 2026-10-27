import { describe, expect, it } from "vitest";
import {
  sandboxSettingsFailureLine,
  sandboxSettingsSteps,
  sandboxSettingsStepsLine,
} from "@traycer/protocol/host/sandbox-settings";

/**
 * The one sentence every surface says when a sandbox is awake but its
 * configuration's settings did not apply, and the steps it groups.
 */

describe("sandboxSettingsFailureLine", () => {
  it("names the sandbox and configuration, then the support reference", () => {
    expect(sandboxSettingsFailureLine("Build box", "Acme", "SBX-0520")).toBe(
      "Build box is awake, but Acme's settings didn't apply · SBX-0520",
    );
  });
});

describe("sandboxSettingsSteps", () => {
  it("groups items into whole steps, a step with any failed item being not applied", () => {
    const steps = sandboxSettingsSteps([
      { kind: "secret", status: "applied" },
      { kind: "secret", status: "applied" },
      { kind: "managed_profile", status: "failed" },
      { kind: "env_override", status: "applied" },
      { kind: "mcp_server", status: "failed" },
      { kind: "mcp_server", status: "unsupported" },
    ]);

    // A step is whole: one failed provider item leaves Providers not applied.
    expect([...steps.applied].sort()).toEqual(["Secrets"]);
    expect([...steps.notApplied].sort()).toEqual(["MCP servers", "Providers"]);
  });

  it("labels an unknown failed kind Other settings, never dropping the failure", () => {
    const steps = sandboxSettingsSteps([
      { kind: "some_future_kind", status: "failed" },
    ]);

    expect(steps.notApplied).toEqual(["Other settings"]);
    expect(steps.applied).toEqual([]);
  });

  it("ignores items still pending", () => {
    expect(
      sandboxSettingsSteps([{ kind: "secret", status: "pending" }]),
    ).toEqual({ applied: [], notApplied: [] });
  });
});

describe("sandboxSettingsStepsLine", () => {
  it("is one sentence naming what applied and what did not, never a raw key or code", () => {
    const line = sandboxSettingsStepsLine({
      applied: ["Secrets"],
      notApplied: ["Providers", "MCP servers"],
    });

    expect(line).not.toContain("\n");
    expect(line).toContain("Secrets");
    expect(line).toContain("Providers");
    expect(line).toContain("MCP servers");
    expect(line).not.toMatch(/permission_denied|API_KEY/);
  });
});
