import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";

/**
 * Regression for `chat-fork-dialog.tsx`: the dialog used to pass
 * `hostScope={{ kind: "active" }}` to `ActiveHostWorkspaceControls`, which
 * lets its host picker call `selectById` - a window-global host rebind. A
 * chat fork dialog is tab-bound (its `createChat` call always targets the
 * TAB's host via `useTabHostId()`/`useTabHostClient()`), so picking a
 * "different" host from a fork dialog must never move the tab, or any other
 * tab, onto that host. The fix passes
 * `buildFixedHostWorkspaceControlsScope({ hostId: tabHostId, hostClient:
 * tabHostClient })` instead, matching `terminal-agent-fork-dialog.tsx` and
 * `new-conversation-modal.tsx`'s tab-bound pickers.
 *
 * `host-workspace-selector.tsx`'s `handleSelectHost` only ever reaches
 * `binding.directory.selectById` when `hostScope.kind !== "fixed"` - so
 * proving the dialog always hands the picker a `"fixed"` scope, pinned to the
 * tab's own host and host client, is a complete proof that this dialog's
 * picker can never fire that global rebind.
 */

const dialogMocks = vi.hoisted(() => ({
  createMutate: vi.fn(),
  capturedHostScope: null as HostWorkspaceControlsHostScope | null,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHost: () => ({
    mutate: dialogMocks.createMutate,
    isPending: false,
  }),
  // #1227 creates on the SELECTED host's client. Full UseMutationResult
  // surface: a partial stub fails every case at once on a member the test
  // never mentions (see chat-tile.test.tsx's identical note).
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

// The cloud-owner read walks the epic store; `null` = owner unknown, the
// neutral arm, which the scope-routing claims never touch.
vi.mock("@/hooks/chats/use-clone-source-owner", () => ({
  useCloneSourceOwnerUserId: () => null,
}));

// #1227's picker rows come from the directory list; one row - the tab host -
// is all the scope-routing claims need.
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

// #1227's dialog resolves the picked target's own requester and reads the
// cloud-owner row through the app-wide client; neither seam matters to the
// scope-routing claims this suite makes.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => null,
  };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => TAB_HOST_CLIENT,
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

// The regression's exact surface: capture the `hostScope` prop the dialog
// actually hands its host/workspace picker instead of stubbing it away, so
// the assertions below see what the dialog passed, not a decoy.
vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: (props: {
      readonly hostScope: HostWorkspaceControlsHostScope;
    }) => {
      dialogMocks.capturedHostScope = props.hostScope;
      return null;
    },
  }),
);

import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";

function buildHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const entry = {
    hostId,
    label: hostId,
    kind: "local" as const,
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

// The tab's own host client (`useTabHostClient()`'s mocked result) - the
// only client the dialog is allowed to thread into a "fixed" scope.
const TAB_HOST_CLIENT = buildHostClient(TAB_HOST_ID);

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

describe("<ChatForkDialog /> host/workspace picker scope", () => {
  afterEach(() => {
    dialogMocks.createMutate.mockReset();
    dialogMocks.capturedHostScope = null;
    cleanup();
  });

  it("pins the picker to the tab's own host - never the app-wide active-host scope", () => {
    render(
      <ChatForkDialog
        open
        target={forkTarget()}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );

    // #1227 made the scope dialog-local (`selected`): the picker owns its
    // target and the DEFAULT is the tab's own host. The protected property is
    // unchanged - the dialog never hands the picker the app-wide scope.
    expect(dialogMocks.capturedHostScope).toMatchObject({
      kind: "selected",
      hostId: TAB_HOST_ID,
    });
    // The regressed shape - `{ kind: "active" }` - is what let the picker
    // call `selectById` and rebind the app-wide active host. Guard against a
    // partial revert as much as against the original bug.
    expect(dialogMocks.capturedHostScope?.kind).not.toBe("active");
  });

  it("keeps the picker pinned to the tab host across an open/close/reopen cycle", () => {
    const view = render(
      <ChatForkDialog
        open
        target={forkTarget()}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );
    expect(dialogMocks.capturedHostScope?.kind).toBe("selected");

    view.rerender(
      <ChatForkDialog
        open={false}
        target={forkTarget()}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );
    view.rerender(
      <ChatForkDialog
        open
        target={forkTarget()}
        epicId="epic-test"
        tabId="tab-test"
        onOpenChange={() => undefined}
      />,
    );

    expect(dialogMocks.capturedHostScope).toMatchObject({
      kind: "selected",
      hostId: TAB_HOST_ID,
    });
  });
});
