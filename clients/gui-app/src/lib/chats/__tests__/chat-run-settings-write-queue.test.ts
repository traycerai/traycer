import { describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  UpdateChatRunSettingsRequest,
  UpdateChatRunSettingsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { appLogger } from "@/lib/logger";
import {
  __chainCountForTests,
  enqueuePersistChatRunSettings,
} from "../chat-run-settings-write-queue";

function makeRequest(
  chatId: string,
  overrides: Partial<UpdateChatRunSettingsRequest>,
): UpdateChatRunSettingsRequest {
  return {
    epicId: "epic-1",
    chatId,
    settings: {
      harnessId: "codex",
      model: "gpt-5.6-terra",
      permissionMode: "supervised",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    },
    ...overrides,
  };
}

function unsupportedError(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "unsupported",
    requestId: "req-1",
    method: "epic.updateChatRunSettings",
    fatalDetails: null,
  });
}

describe("enqueuePersistChatRunSettings", () => {
  it("serializes writes for the same chat - never two in flight at once", async () => {
    const order: string[] = [];
    let resolveFirst: () => void = () => {};
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockImplementationOnce(async () => {
        order.push("first-start");
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        order.push("first-end");
        return { updated: true };
      })
      .mockImplementationOnce(() => {
        order.push("second-start");
        return Promise.resolve({ updated: true });
      });

    enqueuePersistChatRunSettings(mutateAsync, makeRequest("chat-a", {}));
    // A settings change arriving while the first write is still in flight
    // must not start a second request until the first resolves.
    await Promise.resolve();
    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-a", {
        settings: {
          harnessId: "codex",
          model: "gpt-5.6-terra",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: "profile-b",
        },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["first-start"]);
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    // The second call carries the LATEST settings, not an intermediate one.
    expect(mutateAsync.mock.calls[1]?.[0].settings.profileId).toBe("profile-b");
  });

  it("collapses a burst of writes for one chat down to only the final settings", async () => {
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockResolvedValue({ updated: true });

    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-a", {
        settings: {
          harnessId: "codex",
          model: "m1",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: "p1",
        },
      }),
    );
    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-a", {
        settings: {
          harnessId: "codex",
          model: "m2",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: "p2",
        },
      }),
    );
    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-a", {
        settings: {
          harnessId: "codex",
          model: "m3",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: "p3",
        },
      }),
    );

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0].settings.model).toBe("m3");
  });

  it("does not serialize writes across DIFFERENT chats", async () => {
    const startedFor: string[] = [];
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockImplementation((params) => {
        startedFor.push(params.chatId);
        return Promise.resolve({ updated: true });
      });

    enqueuePersistChatRunSettings(mutateAsync, makeRequest("chat-a", {}));
    enqueuePersistChatRunSettings(mutateAsync, makeRequest("chat-b", {}));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(startedFor.sort()).toEqual(["chat-a", "chat-b"]);
  });

  it("swallows E_HOST_UNSUPPORTED silently", async () => {
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockRejectedValue(unsupportedError());

    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-unsupported", {}),
    );

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs any other failure at this transport boundary", async () => {
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
    const failure = new HostRpcError({
      code: "RPC_ERROR",
      message: "connection reset",
      requestId: "req-2",
      method: "epic.updateChatRunSettings",
      fatalDetails: null,
    });
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockRejectedValue(failure);

    enqueuePersistChatRunSettings(mutateAsync, makeRequest("chat-failing", {}));

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      "Failed to persist chat run settings",
    );
    errorSpy.mockRestore();
  });

  it("does not permanently starve a chat's chain when mutateAsync throws synchronously", async () => {
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockImplementationOnce(() => {
        throw new Error("synchronous boom");
      })
      .mockImplementationOnce(() => Promise.resolve({ updated: true }));

    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-sync-throw", {}),
    );
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // A later write for the SAME chat must still go through - the earlier
    // synchronous throw must not leave this chat's chain permanently rejected.
    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-sync-throw", {}),
    );
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    errorSpy.mockRestore();
  });

  it("does not permanently starve a chat's chain when appLogger.error itself throws", async () => {
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {
      throw new Error("logger boom");
    });
    const failure = new HostRpcError({
      code: "RPC_ERROR",
      message: "connection reset",
      requestId: "req-3",
      method: "epic.updateChatRunSettings",
      fatalDetails: null,
    });
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => Promise.resolve({ updated: true }));

    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-logger-throw", {}),
    );
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-logger-throw", {}),
    );
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    errorSpy.mockRestore();
  });

  it("removes an idle chat's chain once its write settles, instead of growing unbounded", async () => {
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockResolvedValue({ updated: true });
    const before = __chainCountForTests();

    enqueuePersistChatRunSettings(mutateAsync, makeRequest("chat-cleanup", {}));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(__chainCountForTests()).toBe(before));
  });

  it("keeps a newer write's chain when an older write's cleanup fires after it", async () => {
    const order: string[] = [];
    const before = __chainCountForTests();
    let resolveFirst: () => void = () => {};
    const mutateAsync = vi
      .fn<
        (
          params: UpdateChatRunSettingsRequest,
        ) => Promise<UpdateChatRunSettingsResponse>
      >()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        order.push("first-settled");
        return { updated: true };
      })
      .mockImplementationOnce(() => {
        order.push("second-start");
        return Promise.resolve({ updated: true });
      });

    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-cleanup-race", {}),
    );
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // Queue a second write for the SAME chat while the first is still in
    // flight - it replaces the chains entry with a NEW chain before the
    // first one settles.
    enqueuePersistChatRunSettings(
      mutateAsync,
      makeRequest("chat-cleanup-race", {}),
    );

    resolveFirst();
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["first-settled", "second-start"]);
    // The second write's own chain must still be tracked/settle correctly -
    // the first write's (now-stale) cleanup must not have deleted it early.
    await vi.waitFor(() => expect(__chainCountForTests()).toBe(before));
  });
});
