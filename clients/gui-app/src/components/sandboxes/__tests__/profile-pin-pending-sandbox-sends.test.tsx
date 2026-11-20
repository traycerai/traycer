import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { readStagedSandbox } from "@/stores/composer/staged-sandbox-store";
import {
  answerHost,
  CODEX_READY,
  mocks,
  mount,
  SANDBOX_HOST,
  createChatCalls,
  seed,
  SEEDED,
  SURFACE,
  waitForCreateChats,
} from "@/components/sandboxes/__tests__/pending-sandbox-send-fixture";

import { PICKED_SETTINGS } from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { removedEntry } from "@/components/providers/__tests__/profile-pin-fixtures";
import { toast } from "sonner";

function refusal(code: "removed-by-person" | "RPC_ERROR", message: string) {
  return new HostRpcError({
    code,
    message,
    requestId: "req-1",
    method: "epic.createChat",
    fatalDetails: null,
  });
}

function toastTitles(calls: ReadonlyArray<readonly unknown[]>): unknown[] {
  return calls.map((call) => call[0]);
}

describe("pending sandbox create and a removed account", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a removed-by-person refusal refuses the send and toasts Was removed", async () => {
    seed(SEEDED);
    mocks.createChatError = refusal(
      "removed-by-person",
      "The send was refused.",
    );
    const toastError = vi.spyOn(toast, "error");
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toEqual({ kind: "not-sent" });
    });
    expect(
      within(screen.getByTestId("sandbox-refusal-line")).getByRole("button", {
        name: "Retry",
      }),
    ).toBeDefined();
    expect(toastTitles(toastError.mock.calls)).toContain("Was removed");
  });

  it("an RPC_ERROR keeps today's uncertain dispatch", async () => {
    seed(SEEDED);
    mocks.createChatError = refusal("RPC_ERROR", "Chat create failed.");
    const toastError = vi.spyOn(toast, "error");
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-sandbox-dispatch").textContent,
      ).toContain("Couldn't confirm the agent was created.");
    });
    expect(toastTitles(toastError.mock.calls)).not.toContain("Was removed");
  });

  it("keeps a removed profile id when the sandbox lists no row", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, profileId: "gone-row" } },
    });
    answerHost(SANDBOX_HOST, {
      ...CODEX_READY,
      removedProfiles: [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
    });
    mount();

    await waitForCreateChats(1);
    const settings = createChatCalls()[0]?.input.settings;
    if (settings === undefined || settings === null) {
      throw new Error("create chat had no settings");
    }
    expect(settings.profileId).toBe("gone-row");
  });

  it("clears an unknown profile id when the sandbox lists no row", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, profileId: "gone-row" } },
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    const settings = createChatCalls()[0]?.input.settings;
    if (settings === undefined || settings === null) {
      throw new Error("create chat had no settings");
    }
    expect(settings.profileId).toBeNull();
  });
});
