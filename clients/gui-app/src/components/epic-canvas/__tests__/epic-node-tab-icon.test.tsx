import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
import { DEFAULT_EPIC_NODE_ICON_COLORS } from "@/lib/artifacts/node-display";
import { iconForSuggestion } from "@/lib/composer/mentions/mention-entry-display";
import type { EntityMentionAttachment } from "@/lib/composer/types";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import {
  __resetAppLocalNotificationsStoreForTests,
  emitTerminalCrashedNotification,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import type {
  EpicArtifactRef,
  EpicTerminalRef,
} from "@/stores/epics/canvas/types";

const TERMINAL_NODE: EpicTerminalRef = {
  id: "terminal-1",
  instanceId: "terminal-instance-1",
  type: "terminal",
  name: "Shell",
  titleSource: "default",
  hostId: "host-1",
  cwd: "/repo",
};

const COMPLETED_TUI_AGENT_NODE: EpicArtifactRef = {
  id: "tui-agent-1",
  instanceId: "tui-agent-instance-1",
  type: "terminal-agent",
  name: "Enable Claude Model Versions",
  hostId: "host-1",
  pendingTuiHarnessId: "claude",
};

describe("<EpicNodeTabIcon /> terminal indicators", () => {
  afterEach(() => {
    cleanup();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("shows and clears the app-local terminal crash icon for the exact tile", () => {
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
    emitTerminalCrashedNotification({
      instanceId: TERMINAL_NODE.instanceId,
      hostId: TERMINAL_NODE.hostId,
      terminalName: TERMINAL_NODE.name,
      target: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: TERMINAL_NODE.id,
        tabId: "view-tab-1",
        paneId: "pane-1",
        tileInstanceId: TERMINAL_NODE.instanceId,
      },
      cause: "exit",
    });

    renderTerminalTabIcon();

    const indicator = screen.getByRole("status", {
      name: "Task needs attention",
    });
    // A terminal failure on the TUI surface draws its own TerminalSquare
    // glyph, distinct from a chat failure's message-square-x.
    const glyph = indicator.querySelector('[data-status-glyph="failure"]');
    expect(glyph?.getAttribute("class")).toContain("text-destructive");
    expect(glyph?.getAttribute("class")).toContain("lucide-square-terminal");

    act(() => {
      useAppLocalNotificationsStore
        .getState()
        .markEntityAsRead(
          TERMINAL_NODE.hostId,
          { epicId: "epic-1", chatId: TERMINAL_NODE.id },
          Date.now(),
        );
    });

    expect(
      screen.queryByRole("status", { name: "Task needs attention" }),
    ).toBeNull();
  });

  it("shows the message-style done icon for a completed TUI agent", () => {
    render(
      <NotificationIndicatorsProvider
        indicators={{
          epics: {},
          chats: {
            [COMPLETED_TUI_AGENT_NODE.id]: {
              pendingApproval: false,
              pendingInterview: false,
              unreadFailure: false,
              unreadDone: true,
              pendingFork: false,
              unreadCount: 1,
            },
          },
        }}
      >
        <EpicNodeTabIcon
          node={COMPLETED_TUI_AGENT_NODE}
          epicId="epic-1"
          variant="live"
          className="size-3.5 shrink-0"
          defaultIcon={undefined}
        />
      </NotificationIndicatorsProvider>,
    );

    const completedIndicator = screen.getByRole("status", {
      name: "Task completed",
    });
    const glyph = completedIndicator.querySelector(
      '[data-status-glyph="done"]',
    );
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute("class")).toContain("text-success-foreground");
  });

  it("shows the terminal failure glyph for a failed TUI agent", () => {
    render(
      <NotificationIndicatorsProvider
        indicators={{
          epics: {},
          chats: {
            [COMPLETED_TUI_AGENT_NODE.id]: {
              pendingApproval: false,
              pendingInterview: false,
              unreadFailure: true,
              unreadDone: false,
              pendingFork: false,
              unreadCount: 1,
            },
          },
        }}
      >
        <EpicNodeTabIcon
          node={COMPLETED_TUI_AGENT_NODE}
          epicId="epic-1"
          variant="live"
          className="size-3.5 shrink-0"
          defaultIcon={undefined}
        />
      </NotificationIndicatorsProvider>,
    );

    const failure = screen.getByRole("status", {
      name: "Task needs attention",
    });
    // The host's unreadFailure bit represents a terminal outcome for a chat.
    const glyph = failure.querySelector('[data-status-glyph="failure"]');
    expect(glyph?.getAttribute("class")).toContain("lucide-square-terminal");
    expect(glyph?.getAttribute("class")).not.toContain(
      "lucide-message-square-x",
    );
  });
});

function renderTerminalTabIcon(): void {
  render(
    <NotificationIndicatorsProvider indicators={{ epics: {}, chats: {} }}>
      <EpicNodeTabIcon
        node={TERMINAL_NODE}
        epicId="epic-1"
        variant="live"
        className="size-3.5 shrink-0"
        defaultIcon={undefined}
      />
    </NotificationIndicatorsProvider>,
  );
}

const TUI_AGENT_NODE: EpicArtifactRef = {
  id: "agent-1",
  instanceId: "agent-instance-1",
  type: "terminal-agent",
  name: "Plan Critic",
  hostId: "host-1",
};

const SPINNER_LABEL = "Agent in progress";

describe("<EpicNodeTabIcon /> terminal-agent activity", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    resetAgentActivity();
    __resetAppLocalNotificationsStoreForTests();
  });

  // Regression: the TUI-agent tab used to hardcode `running={false}`, so a
  // working agent spun in the sidebar but never in its own tab.
  it("swaps the idle icon for the spinner while the agent is working", () => {
    registerEpicSession("epic-1");

    renderTuiAgentTabIcon();

    expect(screen.queryByRole("status", { name: SPINNER_LABEL })).toBeNull();

    act(() => {
      publishWorking([TUI_AGENT_NODE.id]);
    });

    expect(screen.getByRole("status", { name: SPINNER_LABEL })).toBeTruthy();

    act(() => {
      publishWorking([]);
    });

    expect(screen.queryByRole("status", { name: SPINNER_LABEL })).toBeNull();
  });

  // The shared icon renders outside an open-epic session too (drag previews,
  // mount-lifecycle tests); an Epic with no presence must read as idle, not
  // throw.
  it("renders the idle icon with no registered Epic session", () => {
    renderTuiAgentTabIcon();

    expect(screen.queryByRole("status", { name: SPINNER_LABEL })).toBeNull();
  });

  // The defect this whole signal move fixes: activity for an Epic this window
  // has NEVER opened. There is no session and no per-epic room here, so the
  // spinner can only come from the host-selected activity view.
  it("spins for an Epic that was never opened in this window", () => {
    renderTuiAgentTabIcon();

    act(() => {
      publishWorking([TUI_AGENT_NODE.id]);
    });

    expect(screen.getByRole("status", { name: SPINNER_LABEL })).toBeTruthy();
  });
});

function fileNode(id: string, name: string): EpicArtifactRef {
  return {
    id,
    instanceId: `${id}-instance`,
    type: "file",
    name,
    hostId: "host-1",
  };
}

function fileArtifact(
  id: string,
  folderName: string,
  mediaType: string,
): ArtifactProjection {
  return {
    layout: "file",
    object: {
      sha256: "a".repeat(64),
      byteLength: 1024,
      mediaType,
      status: "published",
    },
    id,
    kind: "file",
    title: folderName,
    folderName,
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
  };
}

function renderFileTabIcon(node: EpicArtifactRef): HTMLElement {
  const { container } = render(
    <EpicNodeTabIcon
      node={node}
      epicId="epic-1"
      variant="static"
      className="size-3.5 shrink-0"
      defaultIcon={undefined}
    />,
  );
  return container;
}

describe("<EpicNodeTabIcon /> file artifacts", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("draws the glyph of the viewer the file opens in", () => {
    const handle = registerEpicSession("epic-1");
    handle.store.setState({
      artifacts: {
        allIds: ["video-1", "audio-1"],
        byId: {
          "video-1": fileArtifact("video-1", "walkthrough.mp4", "video/mp4"),
          // Audio is recognised by media type alone, so the name has no
          // extension the viewer would know.
          "audio-1": fileArtifact("audio-1", "voice-note", "audio/mp4"),
        },
      },
    });

    const video = renderFileTabIcon(fileNode("video-1", "walkthrough.mp4"));
    const audio = renderFileTabIcon(fileNode("audio-1", "voice-note"));

    expect(video.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-file-play",
    );
    expect(audio.querySelector("svg")?.getAttribute("class")).toContain(
      "lucide-file-headphone",
    );
  });

  // Drag previews render outside an open-epic session: no file to read, so
  // the tab keeps the plain file glyph instead of throwing.
  it("keeps the plain file glyph with no registered Epic session", () => {
    const icon = renderFileTabIcon(fileNode("video-1", "walkthrough.mp4"));

    const glyphClass = icon.querySelector("svg")?.getAttribute("class");
    expect(glyphClass).toContain("lucide-file");
    expect(glyphClass).not.toContain("lucide-file-play");
  });
});

function artifactMention(
  contextType: "html" | "file-artifact",
  artifactId: string,
  label: string,
): EntityMentionAttachment {
  return {
    kind: "mention",
    contextType,
    path: label,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label,
    description: "Media epic",
    epicId: "epic-1",
    artifactId,
    artifactType: contextType === "html" ? "html" : "file",
    chatId: null,
    terminalAgentId: null,
    terminalId: null,
    status: null,
  };
}

function glyphOf(container: HTMLElement): SVGElement {
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("no glyph rendered");
  return svg;
}

// The surfaces that name an artifact outside the sidebar draw it the way the
// sidebar row does: the kind's glyph in its Settings tint, and a file's viewer.
describe("artifact glyphs on mention surfaces", () => {
  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("tints an HTML row in the mention list with the HTML colour", () => {
    const { container } = render(
      iconForSuggestion({
        kind: "epic-artifact",
        id: "html:epic-1:html-1",
        token: "html:epic-1/html-1",
        epicId: "epic-1",
        epicTitle: "Media epic",
        artifactId: "html-1",
        artifactType: "html",
        label: "Sidebar artifact icons",
        description: "Media epic",
        status: null,
        updatedAt: 0,
      }),
    );

    const glyph = glyphOf(container);
    expect(glyph.getAttribute("class")).toContain("lucide-file-code");
    expect(glyph.style.getPropertyValue("--swatch")).toBe(
      DEFAULT_EPIC_NODE_ICON_COLORS.html,
    );
  });

  // Regression: an HTML chip fell through to the git-branch glyph.
  it("draws an HTML chip in the composer with the HTML glyph", () => {
    const { container } = render(
      <ComposerMentionDecorator
        density="regular"
        mention={artifactMention("html", "html-1", "Sidebar artifact icons")}
      />,
    );

    const glyphClass = glyphOf(container).getAttribute("class");
    expect(glyphClass).toContain("lucide-file-code");
    expect(glyphClass).not.toContain("lucide-git-branch");
  });

  it("draws a file chip in the composer with the glyph of its viewer", () => {
    const handle = registerEpicSession("epic-1");
    handle.store.setState({
      artifacts: {
        allIds: ["video-1"],
        byId: {
          "video-1": fileArtifact("video-1", "walkthrough.mp4", "video/mp4"),
        },
      },
    });

    const { container } = render(
      <ComposerMentionDecorator
        density="regular"
        mention={artifactMention("file-artifact", "video-1", "walkthrough.mp4")}
      />,
    );

    expect(glyphOf(container).getAttribute("class")).toContain(
      "lucide-file-play",
    );
  });
});

function publishWorking(agentIds: readonly string[]): void {
  publishAgentActivity([
    {
      hostId: "host-1",
      byEpic: { "epic-1": { working: agentIds, turn: agentIds } },
    },
  ]);
}

// Returns what the REGISTRY returns, which is the production handle type -
// the registry narrows whatever it is handed. The only caller discards it, so
// nothing here needs the harness's extra members.
function registerEpicSession(epicId: string): OpenEpicStoreHandle {
  return __getOpenEpicRegistryForTests().acquire(epicId, () =>
    openStoreForTest({
      epicId: epicId,
      userId: null,
      // The factories go to the COMPOSITION now: the store stopped
      // constructing a runtime, so a `streamClientFactory` has nowhere
      // else to go.
      factories: {
        streamClientFactory: fakeStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    }),
  );
}

function renderTuiAgentTabIcon(): void {
  render(
    <NotificationIndicatorsProvider indicators={{ epics: {}, chats: {} }}>
      <EpicNodeTabIcon
        node={TUI_AGENT_NODE}
        epicId="epic-1"
        variant="live"
        className="size-3.5 shrink-0"
        defaultIcon={undefined}
      />
    </NotificationIndicatorsProvider>,
  );
}

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});
