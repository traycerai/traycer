import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinueSubagentResponse } from "@traycer/protocol/host/epic/unary-schemas";

const toastError = vi.hoisted(() => vi.fn());
const toastFromHostError = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());
const tabHost = vi.hoisted(() => ({ hostId: "host-tab" }));

vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError }));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => tabHost.hostId,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ request }),
}));

import { useEpicContinueSubagent } from "@/hooks/epic/use-epic-continue-subagent-mutation";
import { epicMutationKeys } from "@/lib/query-keys/epic-mutation-keys";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

const VARIABLES = { epicId: "epic-1", chatId: "chat-1", blockId: "block-1" };

type RefusalReason = Extract<
  ContinueSubagentResponse,
  { kind: "refused" }
>["reason"];

const REASONS: ReadonlyArray<RefusalReason> = [
  "unsupported_harness",
  "block_not_subagent",
  "still_running",
  "session_unreadable",
  "creation_failed",
];

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useEpicContinueSubagent(), { wrapper });
  return { ...hook, queryClient };
}

/** A chat-record list entry as the real hook keys it: the scope plus a sub-key. */
function recordsKey(hostId: string) {
  return [
    ...hostQueryKeys.methodScope(hostId, "epic.listChatRecords"),
    { epicId: "epic-1" },
  ] as const;
}

function seedRecords(queryClient: QueryClient, hostIds: ReadonlyArray<string>) {
  for (const hostId of hostIds) {
    queryClient.setQueryData(recordsKey(hostId), []);
  }
}

function isInvalidated(queryClient: QueryClient, hostId: string): boolean {
  return queryClient.getQueryState(recordsKey(hostId))?.isInvalidated === true;
}

async function run(response: ContinueSubagentResponse): Promise<void> {
  request.mockResolvedValue(response);
  const { result } = setup();
  await act(async () => {
    await result.current.mutateAsync(VARIABLES);
  });
}

describe("useEpicContinueSubagent", () => {
  beforeEach(() => {
    toastError.mockReset();
    toastFromHostError.mockReset();
    request.mockReset();
    tabHost.hostId = "host-tab";
  });

  describe("chat-record invalidation", () => {
    it.each(["created", "existing"] as const)(
      "invalidates the tab host's chat records on %s and no other host's",
      async (kind) => {
        request.mockResolvedValue({ kind, epicId: "epic-1", chatId: "chat-2" });
        const { result, queryClient } = setup();
        seedRecords(queryClient, ["host-tab", "host-other"]);
        await act(async () => {
          await result.current.mutateAsync(VARIABLES);
        });
        expect(isInvalidated(queryClient, "host-tab")).toBe(true);
        expect(isInvalidated(queryClient, "host-other")).toBe(false);
      },
    );

    it("invalidates nothing on a refusal", async () => {
      request.mockResolvedValue({
        kind: "refused",
        reason: "still_running",
        detail: "",
      });
      const { result, queryClient } = setup();
      seedRecords(queryClient, ["host-tab"]);
      await act(async () => {
        await result.current.mutateAsync(VARIABLES);
      });
      expect(isInvalidated(queryClient, "host-tab")).toBe(false);
    });

    it("invalidates nothing when the request is rejected", async () => {
      request.mockRejectedValue(new Error("boom"));
      const { result, queryClient } = setup();
      seedRecords(queryClient, ["host-tab"]);
      await act(async () => {
        await result.current.mutateAsync(VARIABLES).catch(() => undefined);
      });
      expect(isInvalidated(queryClient, "host-tab")).toBe(false);
    });

    it("invalidates the host the request was sent from, not the tab's host now", async () => {
      let deliver: (response: ContinueSubagentResponse) => void = () => {
        throw new Error("no request was made");
      };
      request.mockReturnValue(
        new Promise<ContinueSubagentResponse>((resolve) => {
          deliver = resolve;
        }),
      );
      const { result, rerender, queryClient } = setup();
      seedRecords(queryClient, ["host-tab", "host-moved"]);
      let settled: Promise<unknown> = Promise.resolve();
      act(() => {
        settled = result.current.mutateAsync(VARIABLES);
      });
      await waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      tabHost.hostId = "host-moved";
      rerender();
      await act(async () => {
        deliver({ kind: "created", epicId: "epic-1", chatId: "chat-2" });
        await settled;
      });
      expect(isInvalidated(queryClient, "host-tab")).toBe(true);
      expect(isInvalidated(queryClient, "host-moved")).toBe(false);
    });
  });

  it("sends epic.continueSubagent with exactly the three ids to the tab host client", async () => {
    request.mockResolvedValue({
      kind: "created",
      epicId: "epic-1",
      chatId: "chat-2",
    });
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync(VARIABLES);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("epic.continueSubagent", {
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "block-1",
    });
  });

  it("registers the mutation under its key", async () => {
    request.mockResolvedValue({
      kind: "created",
      epicId: "epic-1",
      chatId: "chat-2",
    });
    const { result, queryClient } = setup();
    await act(async () => {
      await result.current.mutateAsync(VARIABLES);
    });
    const keys = queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.options.mutationKey);
    expect(keys).toEqual([epicMutationKeys.continueSubagent()]);
  });

  it("words each refusal with its own copy and the host's detail", async () => {
    const copies: string[] = [];
    for (const reason of REASONS) {
      toastError.mockReset();
      await run({ kind: "refused", reason, detail: `detail for ${reason}` });
      expect(toastError).toHaveBeenCalledTimes(1);
      const [copy, options] = toastError.mock.calls[0] as [
        string,
        { description: string | undefined },
      ];
      expect(copy.length).toBeGreaterThan(0);
      expect(options).toEqual({ description: `detail for ${reason}` });
      copies.push(copy);
    }
    expect(new Set(copies).size).toBe(REASONS.length);
    expect(copies[REASONS.indexOf("session_unreadable")]).toBe(
      "Couldn't read this subagent's conversation.",
    );
    // `session_unreadable` also covers a truncated record and a provider
    // refusal, so no copy may assert the conversation is gone.
    for (const copy of copies) expect(copy).not.toContain("no longer");
    expect(toastFromHostError).not.toHaveBeenCalled();
  });

  it("gives an empty detail no description", async () => {
    await run({ kind: "refused", reason: "still_running", detail: "" });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]?.[1]).toEqual({ description: undefined });
  });

  it.each(["created", "existing"] as const)(
    "toasts nothing for %s",
    async (kind) => {
      await run({ kind, epicId: "epic-1", chatId: "chat-2" });
      expect(toastError).not.toHaveBeenCalled();
      expect(toastFromHostError).not.toHaveBeenCalled();
    },
  );

  it("reports a rejected request with the fallback copy", async () => {
    request.mockRejectedValue(new Error("boom"));
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync(VARIABLES).catch(() => undefined);
    });
    await waitFor(() => {
      expect(toastFromHostError).toHaveBeenCalledTimes(1);
    });
    expect(toastFromHostError.mock.calls[0]?.[1]).toBe(
      "Couldn't continue this subagent as a chat.",
    );
    expect(toastError).not.toHaveBeenCalled();
  });
});
