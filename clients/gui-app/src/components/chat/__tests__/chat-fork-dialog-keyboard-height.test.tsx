import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";

/**
 * Geometry and open-focus contract for `chat-fork-dialog.tsx`.
 *
 * The dialog carries a title field, a harness picker, stacked workspace
 * controls and a notice stack - a stack taller than a phone viewport before a
 * soft keyboard is anywhere near it. Uncapped, a centre-translated `fixed`
 * dialog puts Fork past the bottom edge with nothing able to scroll to it.
 *
 * The structural guarantee, not pixels: the height cap is applied, the middle
 * region owns the scroll, and the footer sits outside that region so Fork
 * stays put while the form scrolls under it.
 *
 * Focus is the other half, and it is what decides whether a keyboard opens at
 * all. The title field is the first tabbable descendant, so Radix's own
 * open-autofocus takes it - free on a keyboard-driven machine, a summoned
 * software keyboard on a touch one. Both arms are pinned here because the
 * coarse arm is invisible on every developer's desktop.
 */

const dialogMocks = vi.hoisted(() => ({
  createMutate: vi.fn(),
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHost: () => ({
    mutate: dialogMocks.createMutate,
    isPending: false,
  }),
  // The full `UseMutationResult` surface: a partial stub fails every case at
  // once on a member the test never mentions.
  useEpicCreateChatForHostClient: () => ({
    mutate: dialogMocks.createMutate,
    isPending: false,
    reset: () => undefined,
    error: null,
    variables: null,
    data: null,
    isError: false,
    isSuccess: false,
    isIdle: true,
    status: "idle",
    mutateAsync: () => Promise.reject(new Error("unused")),
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    submittedAt: 0,
    context: null,
  }),
}));

const TAB_HOST_ID = "tab-host-id";

vi.mock("@/hooks/chats/use-clone-source-owner", () => ({
  useCloneSourceOwnerUserId: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: TAB_HOST_ID,
        label: "Tab host",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:1/rpc",
        version: "0.0.0-test",
        transportDialability: "dialable",
      },
    ],
    isLoading: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST_ID,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: undefined }),
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => (
    <button type="button" aria-label="Harness picker">
      Claude Opus
    </button>
  ),
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          error: null,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
        },
      ],
    },
    isPending: false,
  }),
  useGuiHarnessModelsQueryForClient: () => ({
    data: {
      models: [
        {
          harnessId: "claude",
          slug: "claude-opus-4-7",
          label: "Claude Opus",
          description: null,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    },
    isPending: false,
  }),
}));

// The workspace controls are the tallest thing in the stack, and their own
// geometry is not what this suite is about; a stand-in keeps the assertions
// pointed at the dialog's three regions.
vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: (_props: {
      readonly hostScope: HostWorkspaceControlsHostScope;
    }) => <div data-testid="workspace-controls-stub" />,
  }),
);

import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";

function forkTarget(): ChatForkDialogTarget {
  return {
    sourceChatId: "source-chat",
    sourceChatTitle: "Source chat",
    assistantMessageId: "assistant-message-1",
    interviewBlockId: null,
    parentId: null,
    settingsSeed: {
      harnessId: "claude",
      model: "claude-opus-4-7",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    },
    workspaceSeed: {
      workspace: { folders: [], folderInfoByPath: {}, primaryPath: null },
      intent: null,
    },
    seedIntentOverride: null,
    carriedInterviews: "settled",
    forkMode: "plain",
    initialHostId: null,
  };
}

function renderDialog(): void {
  render(
    <ChatForkDialog
      open
      target={forkTarget()}
      epicId="epic-test"
      tabId="tab-test"
      onOpenChange={() => undefined}
    />,
  );
}

/**
 * The global test shim answers every media query with `matches: false`, which
 * is the fine-pointer arm. This narrows the coarse-pointer query alone so the
 * rest of the app's queries keep the shim's answer, and the original is put
 * back afterwards so neither arm leaks into the next case.
 */
const originalMatchMedia = window.matchMedia.bind(window);

function stubCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe("<ChatForkDialog /> height cap and footer", () => {
  beforeEach(() => {
    stubCoarsePointer(false);
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    dialogMocks.createMutate.mockReset();
    cleanup();
  });

  it("caps its height against the viewport instead of growing past it", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("max-h-[min(86dvh,calc(100dvh-2rem))]");
    // Header / scroller / footer: the middle track is the only one allowed to
    // take the leftover height, and `minmax(0,…)` is what lets it shrink below
    // its content so the scroll can happen at all.
    expect(dialog.className).toContain("grid-rows-[auto_minmax(0,1fr)_auto]");
  });

  it("scrolls the form and leaves Fork outside the scrolled region", () => {
    renderDialog();

    const scroller = screen.getByTestId("chat-fork-dialog-scroller");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.className).toContain("min-h-0");
    // The field that raises the keyboard is inside the scroll region...
    expect(scroller.contains(screen.getByLabelText("Fork agent title"))).toBe(
      true,
    );

    const footer = screen
      .getByRole("dialog")
      .querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    // ...and the action it exists to reach is not, so scrolling the form never
    // carries Fork off the bottom.
    expect(scroller.contains(footer)).toBe(false);
    expect(footer?.contains(screen.getByRole("button", { name: "Fork" }))).toBe(
      true,
    );
  });

  it("focuses the title field when a fine pointer is driving", () => {
    renderDialog();

    expect(document.activeElement).toBe(
      screen.getByLabelText("Fork agent title"),
    );
  });

  it("leaves the title field unfocused on a coarse pointer", () => {
    stubCoarsePointer(true);
    renderDialog();

    // The whole point: no focused text field means no software keyboard over a
    // form whose common path is "keep the seeded title and press Fork".
    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Fork agent title"),
    );
    // Declining the field is not a licence to strand focus on the trigger,
    // outside the focus scope - the dialog itself takes it.
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
  });
});
