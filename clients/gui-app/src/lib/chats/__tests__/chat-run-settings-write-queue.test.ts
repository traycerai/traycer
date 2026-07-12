import { describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  UpdateChatRunSettingsRequest,
  UpdateChatRunSettingsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { appLogger } from "@/lib/logger";
import { enqueuePersistChatRunSettings } from "../chat-run-settings-write-queue";

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
});
