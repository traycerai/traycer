import { describe, expect, it } from "vitest";
import type {
  EnvironmentItemStatus,
  EnvironmentStatusResponse,
} from "@traycer/protocol/host/environment-schemas";
import {
  envOverrideProviderName,
  itemLabel,
  itemPageName,
  moveRowLabel,
  pendingUploadKeys,
  personalPageItemKinds,
  personalPageStatusLine,
  UPDATE_HOST_TEXT,
  type PersonalHostState,
} from "@/components/settings/personal/personal-page-status";
import {
  environmentStatusFixture,
  itemStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";

const HOST = "dev-box";
const SHELL_KINDS: ReadonlySet<string> = new Set(["variable", "shell"]);

function ready(
  overrides: Partial<EnvironmentStatusResponse>,
): PersonalHostState {
  return { kind: "ready", status: environmentStatusFixture(overrides) };
}

function variable(key: string, overrides: Partial<EnvironmentItemStatus>) {
  return itemStatusFixture({ ...overrides, kind: "variable", key });
}

describe("personalPageStatusLine", () => {
  it("tells an unsupported host to update, and says the page is read-only", () => {
    expect(
      personalPageStatusLine({ kind: "unsupported" }, SHELL_KINDS, HOST),
    ).toEqual({ tone: "info", text: UPDATE_HOST_TEXT });
    expect(UPDATE_HOST_TEXT).toContain("read-only");
  });

  it.each([
    ["unknown", { kind: "unknown" } as const],
    ["not-set-up", { kind: "not-set-up" } as const],
    ["a ready host with no principal", ready({ principal: null })],
  ])("says nothing for %s", (_label, state) => {
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toBeNull();
  });

  it.each(["reconnecting", "offline"])(
    "says changes apply when it reconnects while the host is %s, whatever its items say",
    (reachability) => {
      const state = ready({
        reachability,
        items: [variable("LOG_LEVEL", { status: "failed", code: "timed_out" })],
      });
      expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toEqual({
        tone: "info",
        text: "Changes apply on dev-box when it reconnects.",
      });
    },
  );

  it("says nothing when the host has no item of this page's kinds", () => {
    expect(
      personalPageStatusLine(ready({ items: [] }), SHELL_KINDS, HOST),
    ).toBeNull();
    const onlyOtherKinds = ready({
      items: [
        itemStatusFixture({
          kind: "mcp_server",
          key: "docs",
          status: "failed",
          code: "permission_denied",
        }),
      ],
    });
    expect(
      personalPageStatusLine(onlyOtherKinds, SHELL_KINDS, HOST),
    ).toBeNull();
  });

  it.each([
    [
      "permission_denied",
      "LOG_LEVEL didn't apply on dev-box: permission denied.",
    ],
    [
      "not_installed",
      "LOG_LEVEL didn't apply on dev-box: not installed on this host.",
    ],
    [
      "invalid_value",
      "LOG_LEVEL didn't apply on dev-box: the value isn't valid.",
    ],
    [
      "native_write_failed",
      "LOG_LEVEL didn't apply on dev-box: the setting couldn't be written.",
    ],
    [
      "fetch_failed",
      "LOG_LEVEL didn't apply on dev-box: it couldn't be downloaded.",
    ],
    ["timed_out", "LOG_LEVEL didn't apply on dev-box: it timed out."],
    ["some_future_code", "LOG_LEVEL didn't apply on dev-box."],
    ["script_failed", "LOG_LEVEL didn't apply on dev-box."],
  ])("a failed item with code %s reads: %s", (code, text) => {
    const state = ready({
      items: [variable("LOG_LEVEL", { status: "failed", code })],
    });
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toEqual({
      tone: "warning",
      text,
    });
  });

  describe("a failure whose args name the case", () => {
    const MCP_KINDS: ReadonlySet<string> = new Set(["mcp_server"]);

    function mcpServer(code: string, kind: string | null): PersonalHostState {
      return ready({
        items: [
          itemStatusFixture({
            kind: "mcp_server",
            key: "github-mcp",
            status: "failed",
            code,
            args: { exitStatus: null, stage: null, durationMs: null, kind },
          }),
        ],
      });
    }

    it("tells an MCP server with custom headers to use a token in sandboxes", () => {
      expect(
        personalPageStatusLine(
          mcpServer("unsupported_kind", "headers_in_sandbox"),
          MCP_KINDS,
          HOST,
        ),
      ).toEqual({
        tone: "warning",
        text: "github-mcp didn't apply on dev-box. Use a token for this server in sandboxes.",
      });
    });

    it("keeps the code's own wording when the case is null", () => {
      expect(
        personalPageStatusLine(
          mcpServer("unsupported_kind", null),
          MCP_KINDS,
          HOST,
        )?.text,
      ).toBe("github-mcp didn't apply on dev-box.");
      expect(
        personalPageStatusLine(mcpServer("timed_out", null), MCP_KINDS, HOST)
          ?.text,
      ).toBe("github-mcp didn't apply on dev-box: it timed out.");
    });

    it("keeps the code's own wording for a case this build has no word for", () => {
      expect(
        personalPageStatusLine(
          mcpServer("unsupported_kind", "from_a_newer_host"),
          MCP_KINDS,
          HOST,
        )?.text,
      ).toBe("github-mcp didn't apply on dev-box.");
    });

    it("reads a case only under the code it belongs to", () => {
      expect(
        personalPageStatusLine(
          mcpServer("timed_out", "headers_in_sandbox"),
          MCP_KINDS,
          HOST,
        )?.text,
      ).toBe("github-mcp didn't apply on dev-box: it timed out.");
    });

    it("names the provider a native setting couldn't be written for", () => {
      expect(
        personalPageStatusLine(
          mcpServer("native_write_failed", "claude_code"),
          MCP_KINDS,
          HOST,
        ),
      ).toEqual({
        tone: "warning",
        text: "github-mcp didn't apply on dev-box. It couldn't be written for Claude Code.",
      });
    });

    it("names Codex when the native write failed for codex", () => {
      expect(
        personalPageStatusLine(
          mcpServer("native_write_failed", "codex"),
          MCP_KINDS,
          HOST,
        )?.text,
      ).toBe(
        "github-mcp didn't apply on dev-box. It couldn't be written for Codex.",
      );
    });

    it("keeps the generic reason for a kind it does not know", () => {
      expect(
        personalPageStatusLine(
          mcpServer("native_write_failed", "not_a_provider"),
          MCP_KINDS,
          HOST,
        )?.text,
      ).toBe(
        "github-mcp didn't apply on dev-box: the setting couldn't be written.",
      );
    });
  });

  it("names the shell by its page label, not a key, when the shell item failed", () => {
    const state = ready({
      items: [
        itemStatusFixture({
          kind: "shell",
          key: "default",
          status: "failed",
          code: "not_installed",
        }),
      ],
    });
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)?.text).toBe(
      "The shell didn't apply on dev-box: not installed on this host.",
    );
  });

  it("asks for an update when an unsupported item carries a compatibility floor", () => {
    const state = ready({
      items: [
        variable("LOG_LEVEL", {
          status: "unsupported",
          minimumHostVersion: "1.6.0",
        }),
      ],
    });
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toEqual({
      tone: "info",
      text: "Update dev-box to use LOG_LEVEL.",
    });
  });

  it("says the version does not support an item yet when there is no floor", () => {
    const state = ready({
      items: [
        variable("LOG_LEVEL", {
          status: "unsupported",
          minimumHostVersion: null,
        }),
      ],
    });
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toEqual({
      tone: "info",
      text: "LOG_LEVEL isn't supported on this host version yet.",
    });
  });

  it("says an item is applying while it is pending", () => {
    const state = ready({
      items: [variable("LOG_LEVEL", { status: "pending" })],
    });
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toEqual({
      tone: "info",
      text: "Applying LOG_LEVEL on dev-box.",
    });
  });

  it("says nothing when every item of the page is applied", () => {
    const state = ready({
      items: [
        variable("LOG_LEVEL", { status: "applied" }),
        itemStatusFixture({ kind: "shell", key: "default", status: "applied" }),
      ],
    });
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toBeNull();
  });

  it("ignores items of other kinds, failed or not", () => {
    const state = ready({
      items: [
        variable("LOG_LEVEL", { status: "applied" }),
        itemStatusFixture({
          kind: "mcp_server",
          key: "docs",
          status: "failed",
          code: "permission_denied",
        }),
        itemStatusFixture({ kind: "skill", key: "s", status: "pending" }),
      ],
    });
    expect(personalPageStatusLine(state, SHELL_KINDS, HOST)).toBeNull();
  });

  describe("worst first when several statuses mix", () => {
    const applied = variable("A_APPLIED", { status: "applied" });
    const pending = variable("B_PENDING", { status: "pending" });
    const unsupported = variable("C_UNSUPPORTED", {
      status: "unsupported",
      minimumHostVersion: "1.6.0",
    });
    const failed = variable("D_FAILED", {
      status: "failed",
      code: "invalid_value",
    });

    it("a failure beats everything, wherever it sits in the list", () => {
      for (const items of [
        [failed, unsupported, pending, applied],
        [applied, pending, unsupported, failed],
      ]) {
        expect(
          personalPageStatusLine(ready({ items }), SHELL_KINDS, HOST),
        ).toEqual({
          tone: "warning",
          text: "D_FAILED didn't apply on dev-box: the value isn't valid.",
        });
      }
    });

    it("unsupported beats pending and applied", () => {
      expect(
        personalPageStatusLine(
          ready({ items: [applied, pending, unsupported] }),
          SHELL_KINDS,
          HOST,
        )?.text,
      ).toBe("Update dev-box to use C_UNSUPPORTED.");
    });

    it("pending beats applied", () => {
      expect(
        personalPageStatusLine(
          ready({ items: [applied, pending] }),
          SHELL_KINDS,
          HOST,
        )?.text,
      ).toBe("Applying B_PENDING on dev-box.");
    });

    it("reports the first of several failures", () => {
      const second = variable("E_FAILED", {
        status: "failed",
        code: "timed_out",
      });
      expect(
        personalPageStatusLine(
          ready({ items: [failed, second] }),
          SHELL_KINDS,
          HOST,
        )?.text,
      ).toBe("D_FAILED didn't apply on dev-box: the value isn't valid.");
    });
  });
});

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
  ])("names %s as %s", (kind, name) => {
    expect(itemPageName(kind)).toBe(name);
  });
});

describe("moveRowLabel", () => {
  it.each([
    [{ kind: "variable", key: "EDITOR", label: "EDITOR" }, "EDITOR"],
    [{ kind: "mcp_server", key: "gh", label: "github-mcp" }, "github-mcp"],
    [{ kind: "env_override", key: "no-such:X", label: "X" }, "X"],
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
