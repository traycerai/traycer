import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostRuntimeProvider, hostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

// R3: `ComposerToolbarContextMenu` (composer-toolbar.tsx) had the same
// conditional-wrapper bug as the header's cluster - it used to render either
// `<ContextMenu>...</ContextMenu>` or bare `props.children` depending on
// `showCustomizeEntry`, remounting everything inside (the whole left/right
// toolbar clusters) on every Customize session start/stop or
// `visualLayoutEditorEnabled` flip. The fix keeps `<ContextMenu>` mounted
// always, toggling only the trigger's `disabled` and whether
// `ContextMenuContent` renders. Proven the same way as the header test: each
// cluster gets a mount id that only changes on a genuine new mount, and the
// id painted to the DOM must survive every transition.
const mountCounters = vi.hoisted(() => ({ left: 0, right: 0 }));
vi.mock("@/components/home/toolbar/composer-toolbar-left", () => ({
  ComposerToolbarLeft: () => {
    const [mountId] = useState(() => ++mountCounters.left);
    return <div data-testid="toolbar-left-leaf" data-mount-id={mountId} />;
  },
}));
vi.mock("@/components/home/toolbar/composer-toolbar-right", () => ({
  ComposerToolbarRight: () => {
    const [mountId] = useState(() => ++mountCounters.right);
    return <div data-testid="toolbar-right-leaf" data-mount-id={mountId} />;
  },
}));

function testToolbarStore() {
  return createComposerToolbarStore({
    seedKey: "composer-toolbar-context-menu-identity-test",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
}

function mountId(testId: string): string | null {
  return screen.getByTestId(testId).getAttribute("data-mount-id");
}

describe("ComposerToolbar keeps its clusters mounted across Customize/setting flips", () => {
  beforeEach(() => {
    mountCounters.left = 0;
    mountCounters.right = 0;
    useCustomizeStore.setState({ session: null, instances: new Map() });
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  });
  afterEach(() => {
    cleanup();
  });

  it("never remounts ComposerToolbarLeft/Right across session enter/exit or the visualLayoutEditorEnabled switch", async () => {
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "https://authn.traycer.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <QueryClientProvider client={new QueryClient()}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            fallback={null}
            messengerFactory={null}
            invalidator={null}
            requestId={null}
            remoteFetcher={null}
          >
            <ComposerToolbar
              store={testToolbarStore()}
              onAttachImages={() => undefined}
              canSubmit
              attachmentPending={false}
              onSubmit={() => undefined}
              activeTurnStatus={null}
              stopDisabled={false}
              onStopTurn={null}
              composerDisabledHint={null}
              dictation={null}
              dictationPreparing={null}
              settingsLocked={false}
              createProfileHostId={null}
              runTargetHostId={null}
              terminalLoginSurface={null}
              chatLineCarriesAutoMode={null}
            />
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>,
    );

    await screen.findByTestId("toolbar-left-leaf");
    const initialLeftId = mountId("toolbar-left-leaf");
    const initialRightId = mountId("toolbar-right-leaf");
    expect(initialLeftId).not.toBeNull();
    expect(initialRightId).not.toBeNull();

    act(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    });
    expect(mountId("toolbar-left-leaf")).toBe(initialLeftId);
    expect(mountId("toolbar-right-leaf")).toBe(initialRightId);

    act(() => {
      useCustomizeStore.setState({
        session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
        instances: new Map(),
        history: { past: [], future: [] },
        announcement: "",
      });
    });
    expect(mountId("toolbar-left-leaf")).toBe(initialLeftId);
    expect(mountId("toolbar-right-leaf")).toBe(initialRightId);

    act(() => {
      useCustomizeStore.setState({ session: null, instances: new Map() });
    });
    expect(mountId("toolbar-left-leaf")).toBe(initialLeftId);
    expect(mountId("toolbar-right-leaf")).toBe(initialRightId);

    act(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    });
    expect(mountId("toolbar-left-leaf")).toBe(initialLeftId);
    expect(mountId("toolbar-right-leaf")).toBe(initialRightId);

    expect(mountCounters.left).toBe(1);
    expect(mountCounters.right).toBe(1);
  });
});
