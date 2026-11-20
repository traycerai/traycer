import { describe, expect, it } from "vitest";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import {
  envOverrideProviderName,
  itemLabel,
  itemPageName,
  moveRowLabel,
  pendingUploadKeys,
  personalPageItemKinds,
  type PersonalHostState,
} from "@/components/settings/personal/personal-page-status";
import {
  environmentStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";

function ready(
  overrides: Partial<EnvironmentStatusResponse>,
): PersonalHostState {
  return { kind: "ready", status: environmentStatusFixture(overrides) };
}

describe("itemLabel", () => {
  it.each([
    [{ kind: "variable", key: "LOG_LEVEL" }, "LOG_LEVEL"],
    [
      { kind: "env_override", key: "claude-code:ANTHROPIC_BASE_URL" },
      "ANTHROPIC_BASE_URL",
    ],
    [{ kind: "env_override", key: "claude-code:A:B" }, "A:B"],
    [{ kind: "env_override", key: "NO_SEPARATOR" }, "NO_SEPARATOR"],
    [{ kind: "pack_policy", key: "claude-code" }, "claude-code"],
    [{ kind: "mcp_server", key: "github-mcp" }, "github-mcp"],
    [{ kind: "shell", key: "default" }, "The shell"],
    [{ kind: "fallback_policy", key: "x" }, "Model routing"],
    [{ kind: "agent_selection_guide", key: "x" }, "Agent selection"],
    [{ kind: "browser_agent_access", key: "x" }, "Browser agent access"],
    [{ kind: "auto_policy", key: "x" }, "Permissions"],
    [{ kind: "managed_profile", key: "p1" }, "A profile"],
    [{ kind: "something_new", key: "x" }, "A setting"],
    [{ kind: "constructor", key: "x" }, "A setting"],
  ])("labels %j as %s", (item, label) => {
    expect(itemLabel(item)).toBe(label);
  });
});

describe("itemPageName", () => {
  it.each([
    ["shell", "The shell"],
    ["fallback_policy", "Model routing"],
    ["agent_selection_guide", "Agent selection"],
    ["browser_agent_access", "Browser agent access"],
    ["auto_policy", "Permissions"],
    ["variable", null],
    ["mcp_server", null],
    ["something_new", null],
    ["constructor", null],
  ])("names %s as %s", (kind, name) => {
    expect(itemPageName(kind)).toBe(name);
  });
});

describe("moveRowLabel", () => {
  it.each([
    [{ kind: "variable", key: "EDITOR", label: "EDITOR" }, "EDITOR"],
    [{ kind: "mcp_server", key: "gh", label: "github-mcp" }, "github-mcp"],
    [
      { kind: "constructor", key: "k", label: "its own label" },
      "its own label",
    ],
    [{ kind: "env_override", key: "no-such:X", label: "X" }, "X"],
    [
      {
        kind: "env_override",
        key: "claude-code:ANTHROPIC_BASE_URL",
        label: "ANTHROPIC_BASE_URL",
      },
      "ANTHROPIC_BASE_URL (Claude Code)",
    ],
  ])("names the row %j as %s", (row, label) => {
    expect(moveRowLabel(row)).toBe(label);
  });
});

describe("envOverrideProviderName", () => {
  it.each([
    ["claude-code:ANTHROPIC_BASE_URL", "Claude Code"],
    ["no-such-provider:X", null],
    ["NO_SEPARATOR", null],
  ])("reads %s as %s", (key, name) => {
    expect(envOverrideProviderName(key)).toBe(name);
  });
});

describe("pendingUploadKeys", () => {
  const state = ready({
    pendingUploads: [
      pendingUploadFixture({ kind: "variable", key: "WAITING" }),
      pendingUploadFixture({
        kind: "variable",
        key: "ACCEPTED",
        receipt: "accepted",
      }),
      pendingUploadFixture({
        kind: "variable",
        key: "REFUSED",
        receipt: "refused",
        code: "invalid_value",
      }),
      pendingUploadFixture({
        kind: "env_override",
        key: "claude-code:OTHER_KIND",
      }),
      pendingUploadFixture({ kind: "variable", key: "ALSO_WAITING" }),
    ],
  });

  it("holds only the keys of that kind whose receipt is still pending", () => {
    expect([...pendingUploadKeys(state, "variable")].sort()).toEqual([
      "ALSO_WAITING",
      "WAITING",
    ]);
    expect([...pendingUploadKeys(state, "env_override")]).toEqual([
      "claude-code:OTHER_KIND",
    ]);
  });

  it("is empty for a kind with no waiting upload", () => {
    expect(pendingUploadKeys(state, "shell").size).toBe(0);
  });

  it.each([
    ["unsupported", { kind: "unsupported" } as const],
    ["unknown", { kind: "unknown" } as const],
    ["not-set-up", { kind: "not-set-up" } as const],
  ])("is empty while the host state is %s", (_label, notReady) => {
    expect(pendingUploadKeys(notReady, "variable").size).toBe(0);
  });
});

describe("personalPageItemKinds", () => {
  it("lists the item kinds each Personal page edits", () => {
    expect([...(personalPageItemKinds("shell") ?? [])].sort()).toEqual([
      "shell",
      "variable",
    ]);
    expect(personalPageItemKinds("fallback")?.has("fallback_policy")).toBe(
      true,
    );
    expect(personalPageItemKinds("providers")?.has("env_override")).toBe(true);
    expect([...(personalPageItemKinds("agents") ?? [])].sort()).toEqual([
      "agent_definition",
      "agent_selection_guide",
    ]);
    expect(personalPageItemKinds("browser-agent-access")).toBeNull();
  });

  it("lists the item kinds the MCP servers, Skills and Machine setup pages edit", () => {
    expect([...(personalPageItemKinds("mcp-servers") ?? [])]).toEqual([
      "mcp_server",
    ]);
    expect([...(personalPageItemKinds("skills") ?? [])]).toEqual(["skill"]);
    expect(personalPageItemKinds("agent-definitions")).toBeNull();
    expect([...(personalPageItemKinds("machine-setup") ?? [])]).toEqual([
      "setup_script",
    ]);
  });

  it("is null for a page that is not a Personal page", () => {
    expect(personalPageItemKinds("general")).toBeNull();
  });
});
