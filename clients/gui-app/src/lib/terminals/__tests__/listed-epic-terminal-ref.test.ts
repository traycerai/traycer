import { afterEach, describe, expect, it } from "vitest";
import { makeListedEpicTerminalRef } from "@/lib/terminals/listed-epic-terminal-ref";
import type { ListedTerminalSidebarSession } from "@/lib/terminals/reconcile-terminal-sidebar-sessions";
import {
  isImportExemptEpicTerminalRef,
  isLegacyEpicTerminalRef,
} from "@/stores/epics/canvas/types";
import {
  recordProviderLoginTerminal,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";
import {
  recordSetupTerminal,
  useSetupTerminalsStore,
} from "@/stores/worktree/setup-terminals";

const HOST_ID = "host-1";

function listed(
  sessionId: string,
  lifecycleOwner: ListedTerminalSidebarSession["lifecycleOwner"],
): ListedTerminalSidebarSession {
  return {
    sessionId,
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "/tmp/work",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 1,
    title: sessionId,
    ...(lifecycleOwner === undefined ? {} : { lifecycleOwner }),
  };
}

describe("makeListedEpicTerminalRef", () => {
  afterEach(() => {
    useSetupTerminalsStore.setState({
      trackedBySessionKey: {},
      recentKeys: [],
    });
    useProviderLoginTerminalsStore.setState({
      providerBySessionKey: {},
      recentKeys: [],
    });
  });

  it("keeps a manager row manager-owned with empty origin stores", () => {
    const ref = makeListedEpicTerminalRef({
      session: listed("setup-term", "manager"),
      hostId: HOST_ID,
      instanceId: "inst-1",
      durable: false,
    });
    expect(isLegacyEpicTerminalRef(ref)).toBe(true);
    expect(ref.lifecycleOwner).toBe("manager");
    expect(ref.origin).toBeUndefined();
    expect(ref.hostId).toBe(HOST_ID);
    expect(isImportExemptEpicTerminalRef(ref)).toBe(true);
  });

  it("does not let a stale origin cache override manager or registry wire ownership", () => {
    recordSetupTerminal({ hostId: HOST_ID, sessionId: "other-term" });
    recordProviderLoginTerminal({
      hostId: HOST_ID,
      sessionId: "login-term",
      providerId: "codex",
    });
    const manager = makeListedEpicTerminalRef({
      session: listed("setup-term", "manager"),
      hostId: HOST_ID,
      instanceId: "inst-manager",
      durable: false,
    });
    expect(manager.lifecycleOwner).toBe("manager");
    expect(manager.origin).toBeUndefined();
    expect(isImportExemptEpicTerminalRef(manager)).toBe(true);

    const registry = makeListedEpicTerminalRef({
      session: listed("login-term", "registry"),
      hostId: HOST_ID,
      instanceId: "inst-registry",
      durable: false,
    });
    expect(registry.lifecycleOwner).toBe("registry");
    expect(registry.origin).toBe("provider-login");
    expect(isImportExemptEpicTerminalRef(registry)).toBe(false);
  });

  it("treats a registry listed row as an import candidate", () => {
    const ref = makeListedEpicTerminalRef({
      session: listed("shadow", "registry"),
      hostId: HOST_ID,
      instanceId: "inst-shadow",
      durable: false,
    });
    expect(ref.lifecycleOwner).toBe("registry");
    expect(isImportExemptEpicTerminalRef(ref)).toBe(false);
  });
});
