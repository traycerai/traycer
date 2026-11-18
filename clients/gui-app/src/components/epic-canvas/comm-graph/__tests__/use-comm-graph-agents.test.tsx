const hostDirectoryMock = vi.hoisted(() => ({
  findById: (hostId: string) => ({
    hostId,
    label: hostId,
    kind: "remote" as const,
    websocketUrl: `wss://${hostId}.example/stream`,
    version: "1.0.0",
    transportDialability: "dialable" as const,
  }),
  onChange: () => ({ dispose: () => undefined }),
}));

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostDirectory: () => hostDirectoryMock,
  useHostBinding: () => null,
}));

vi.mock("@/lib/host/use-durable-stream-transport", async () => {
  const { fakeDurableStreamTransports } =
    await import("@/lib/host/test-support/fake-durable-stream-transport");
  return {
    useDurableStreamTransportFactory: () =>
      fakeDurableStreamTransports().opener,
  };
});

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-a",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as Y from "yjs";
import { useCommGraphAgents } from "@/components/epic-canvas/comm-graph/use-comm-graph-agents";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import { createEpicSessionTestHarness } from "@/components/epic-canvas/__tests__/test-epic-session-harness";

const EPIC_ID = "epic-comm-graph-agents";
const SETTLED_CHAT_ID = "chat-settled";
const BARE_CHAT_ID = "chat-bare";
const TUI_ID = "tui-1";
const HOST_A = "host-a";

const harness = createEpicSessionTestHarness(EPIC_ID);

function seedDoc(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();

  // A chat that has been given run settings carries a harness and a model.
  const settled = new Y.Map<unknown>();
  settled.set("id", SETTLED_CHAT_ID);
  settled.set("title", "Orchestrator");
  settled.set("parentId", null);
  settled.set("createdAt", 1);
  settled.set("updatedAt", 1);
  settled.set("hostId", HOST_A);
  const settings = new Y.Map<unknown>();
  settings.set("harnessId", "claude");
  settings.set("model", "opus");
  settings.set("permissionMode", "full_access");
  settings.set("reasoningEffort", null);
  settings.set("agentMode", "regular");
  settled.set("settings", settings);
  settled.set("messages", new Y.Array<unknown>());
  chats.set(SETTLED_CHAT_ID, settled);

  // One that has not: both fields stay unresolved rather than being guessed.
  const bare = new Y.Map<unknown>();
  bare.set("id", BARE_CHAT_ID);
  bare.set("title", "Fresh");
  bare.set("parentId", null);
  bare.set("createdAt", 2);
  bare.set("updatedAt", 2);
  bare.set("hostId", HOST_A);
  bare.set("messages", new Y.Array<unknown>());
  chats.set(BARE_CHAT_ID, bare);

  const tuiAgents = new Y.Map<unknown>();
  const tui = new Y.Map<unknown>();
  tui.set("id", TUI_ID);
  tui.set("harnessId", "codex");
  tui.set("harnessSessionId", "session-1");
  tui.set("agentMode", "regular");
  tui.set("model", "gpt-5.4");
  tui.set("title", "Reviewer");
  tui.set("parentId", SETTLED_CHAT_ID);
  tui.set("createdAt", 3);
  tui.set("updatedAt", 3);
  tui.set("hostId", HOST_A);
  tuiAgents.set(TUI_ID, tui);

  epic.set("title", "Epic");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", tuiAgents);
  epic.set("chats", chats);
}

function wrapper(props: { readonly children: ReactNode }) {
  return (
    <TestEpicSessionWrapper epicId={EPIC_ID}>
      {props.children}
    </TestEpicSessionWrapper>
  );
}

beforeEach(() => {
  harness.install(seedDoc, "owner");
});

afterEach(() => {
  harness.teardown();
  cleanup();
});

/**
 * The office draws a harness logo on every desk and names the model on hover,
 * so both have to reach the canvas as facts about the AGENT. They come from
 * two differently-shaped records - a chat's persisted run settings, a terminal
 * agent's own columns - and this is where those two shapes are flattened into
 * one.
 */
describe("useCommGraphAgents harness and model", () => {
  it("reads a chat's harness and model out of its run settings", async () => {
    const { result } = renderHook(() => useCommGraphAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.nodes.length).toBe(3);
    });
    const settled = result.current.nodes.find(
      (node) => node.id === SETTLED_CHAT_ID,
    );
    expect(settled?.harnessId).toBe("claude");
    expect(settled?.model).toBe("opus");
  });

  it("leaves both unresolved for a chat with no run settings", async () => {
    const { result } = renderHook(() => useCommGraphAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.nodes.length).toBe(3);
    });
    const bare = result.current.nodes.find((node) => node.id === BARE_CHAT_ID);
    // Not guessed at from a default: a chat that has never been configured has
    // no harness, and the floor draws no logo rather than the wrong one.
    expect(bare?.harnessId).toBeNull();
    expect(bare?.model).toBeNull();
  });

  it("takes a terminal agent's harness and model from its own record", async () => {
    const { result } = renderHook(() => useCommGraphAgents(), { wrapper });

    await waitFor(() => {
      expect(result.current.nodes.length).toBe(3);
    });
    const tui = result.current.nodes.find((node) => node.id === TUI_ID);
    expect(tui?.harnessId).toBe("codex");
    expect(tui?.model).toBe("gpt-5.4");
  });
});
