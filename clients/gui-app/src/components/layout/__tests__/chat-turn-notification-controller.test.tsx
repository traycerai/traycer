import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";

interface CapturedCompletion {
  readonly epicId: string;
  readonly chatId: string;
  readonly chatTitle: string | null;
}

// Shared between the hoisted module mocks and the tests: epicId → live title.
const { epicTitles } = vi.hoisted(() => ({
  epicTitles: new Map<string, string>(),
}));

let capturedOnComplete: ((completion: CapturedCompletion) => void) | null =
  null;
const unsubscribeSpy = vi.fn();

vi.mock("@/lib/notifications/chat-turn-completion", () => ({
  subscribeChatTurnCompletions: (
    onComplete: (completion: CapturedCompletion) => void,
  ): (() => void) => {
    capturedOnComplete = onComplete;
    return unsubscribeSpy;
  },
}));

vi.mock("@/lib/registries/epic-session-registry", () => ({
  getOpenEpicRegistry: () => ({
    peek: (epicId: string) => (epicTitles.has(epicId) ? { epicId } : null),
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  liveEpicTitleFromHandle: (
    handle: { readonly epicId: string } | null,
  ): string | null =>
    handle === null ? null : (epicTitles.get(handle.epicId) ?? null),
}));

import { ChatTurnNotificationController } from "@/components/layout/bridges/chat-turn-notification-controller";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";

function makeHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.test/sign-in",
    authnBaseUrl: "https://example.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function mountWith(host: MockRunnerHost): void {
  render(
    <RunnerHostProvider runnerHost={host}>
      <ChatTurnNotificationController />
    </RunnerHostProvider>,
  );
}

const COMPLETION: CapturedCompletion = {
  epicId: "epic-1",
  chatId: "chat-1",
  chatTitle: "Casual greeting",
};

describe("ChatTurnNotificationController", () => {
  beforeEach(() => {
    capturedOnComplete = null;
    unsubscribeSpy.mockReset();
    epicTitles.clear();
    useSettingsStore.setState({ notifyOnChatTurnComplete: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSettingsStore.setState({ notifyOnChatTurnComplete: true });
  });

  it("fires an epic/chat notification when a turn completes while unfocused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    epicTitles.set("epic-1", "Payments revamp");
    const host = makeHost();
    mountWith(host);

    act(() => {
      capturedOnComplete?.(COMPLETION);
    });

    expect(host.notificationsSent).toEqual([
      {
        title: "Payments revamp",
        body: "Casual greeting • Done",
        payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      },
    ]);
  });

  it("does not fire while the app window is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    epicTitles.set("epic-1", "Payments revamp");
    const host = makeHost();
    mountWith(host);

    act(() => {
      capturedOnComplete?.(COMPLETION);
    });

    expect(host.notificationsSent).toEqual([]);
  });

  it("does not fire when the setting is disabled", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    useSettingsStore.setState({ notifyOnChatTurnComplete: false });
    const host = makeHost();
    mountWith(host);

    act(() => {
      capturedOnComplete?.(COMPLETION);
    });

    expect(host.notificationsSent).toEqual([]);
  });

  it("shows 'Untitled epic' when the epic is open but not yet titled", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    // Handle is registered (epic is open) but the live title is empty - the
    // not-yet-titled terminal-agent epic case. The notification must surface
    // "Untitled epic", not the generic app-name fallback.
    epicTitles.set("epic-1", "");
    const host = makeHost();
    mountWith(host);

    act(() => {
      capturedOnComplete?.(COMPLETION);
    });

    expect(host.notificationsSent).toEqual([
      {
        title: "Untitled epic",
        body: "Casual greeting • Done",
        payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      },
    ]);
  });

  it("falls back to the app name and 'New chat' when titles are unknown", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const host = makeHost();
    mountWith(host);

    act(() => {
      capturedOnComplete?.({
        epicId: "epic-x",
        chatId: "chat-9",
        chatTitle: null,
      });
    });

    expect(host.notificationsSent).toEqual([
      {
        title: "Traycer",
        body: "New chat • Done",
        payload: { kind: "chat", epicId: "epic-x", chatId: "chat-9" },
      },
    ]);
  });
});
