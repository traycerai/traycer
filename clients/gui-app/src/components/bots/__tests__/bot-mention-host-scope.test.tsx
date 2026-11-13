import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { BotMemoryContext } from "@/components/bots/bot-memory-context";
import { useBotMentionCompletion } from "@/components/bots/bot-mention-completion";

const requests = vi.hoisted(() => ({
  ids: [] as string[],
  pending: false,
  empty: false,
}));
vi.mock("@/hooks/bots/use-environment-host-lists-query", () => ({
  useEnvironmentHostLists: (_client: unknown, ids: string[]) => {
    requests.ids = ids;
    const hostsByEnvironmentId = new Map<
      string,
      Array<{ hostId: string; hostLabel: string }>
    >();
    if (!requests.pending) {
      hostsByEnvironmentId.set(
        "team-a",
        requests.empty
          ? []
          : [{ hostId: "team-host", hostLabel: "Studio Team" }],
      );
      if (!requests.empty) {
        hostsByEnvironmentId.set("team-b", [
          { hostId: "other-host", hostLabel: "Studio Other" },
        ]);
      }
    }
    return { hostsByEnvironmentId };
  },
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      { hostId: "personal-host", label: "Studio Personal", kind: "personal" },
    ],
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneFocused: () => true,
}));

function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <BotMemoryContext
      value={{
        hostId: "serving-host",
        botId: "bot",
        environmentId: "team-a",
        open: () => {},
      }}
    >
      {children}
    </BotMemoryContext>
  );
}

afterEach(() => {
  cleanup();
  requests.ids = [];
  requests.pending = false;
  requests.empty = false;
});

it("offers only hosts from the bot's environment", async () => {
  const { result } = renderHook(
    () => useBotMentionCompletion({ replyRow: null }),
    { wrapper: Wrapper },
  );
  act(() =>
    result.current.pickerStore.getState().openPicker({
      sessionId: 1,
      kind: "mention",
      slashScope: null,
      slashTrigger: null,
      range: { from: 0, to: 7 },
      query: "studio",
      commit: vi.fn(),
      dismiss: null,
      focusEditor: null,
      clientRect: null,
    }),
  );
  await waitFor(() =>
    expect(
      result.current.pickerStore.getState().items.map((item) => item.id),
    ).toEqual(["provider:hosts"]),
  );
  act(() =>
    result.current.pickerStore.getState().setStep({
      kind: "provider",
      providerId: "hosts",
      stepId: "root",
      workspacePath: null,
    }),
  );
  await waitFor(() =>
    expect(
      result.current.pickerStore.getState().items.map((item) => item.id),
    ).toEqual(["mention-back", "host:team-host"]),
  );
  expect(result.current.pickerStore.getState().items[1]).toMatchObject({
    entry: { action: { kind: "complete", mention: { hostId: "team-host" } } },
  });
  expect(requests.ids).toEqual(["team-a"]);
});

it("keeps bare @ open while hosts are pending and dismisses after an empty answer", async () => {
  requests.pending = true;
  const { result, rerender } = renderHook(
    () => useBotMentionCompletion({ replyRow: null }),
    { wrapper: Wrapper },
  );
  act(() =>
    result.current.pickerStore.getState().openPicker({
      sessionId: 1,
      kind: "mention",
      slashScope: null,
      slashTrigger: null,
      range: { from: 0, to: 1 },
      query: "",
      commit: vi.fn(),
      dismiss: null,
      focusEditor: null,
      clientRect: null,
    }),
  );
  expect(result.current.pickerStore.getState().open).toBe(true);
  requests.pending = false;
  requests.empty = true;
  rerender();
  await waitFor(() =>
    expect(result.current.pickerStore.getState().open).toBe(false),
  );
});
