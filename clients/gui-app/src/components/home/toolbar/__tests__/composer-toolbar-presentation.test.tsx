import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerTileIdProvider } from "@/components/home/composer/composer-tile-context";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const hostHooks = vi.hoisted(() => ({
  schemaVersion: vi.fn((_hostId: string | null, _method: string) => null),
  judgeBilling: vi.fn(
    (_hostId: string | null, _harnessId: string | null) => null,
  ),
}));
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-supports-method")
  >()),
  useHostMethodSchemaVersion: hostHooks.schemaVersion,
}));
vi.mock("@/hooks/auto-mode/use-auto-judge-billing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/auto-mode/use-auto-judge-billing")
  >()),
  useAutoJudgeBilling: hostHooks.judgeBilling,
}));
// Real picker in presentation mode; a stub for the live one.
vi.mock(
  "@/components/home/pickers/harness-model-picker",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/home/pickers/harness-model-picker")
      >();
    return {
      ...actual,
      HarnessModelPicker: (
        props: ComponentProps<typeof actual.HarnessModelPicker>,
      ) =>
        props.presentation === true ? (
          <actual.HarnessModelPicker {...props} />
        ) : (
          <div data-testid="live-model-picker-stub" />
        ),
    };
  },
);

const TILE = "presentation-tile";

function toolbarStore() {
  return createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "composer-toolbar-presentation-test",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "sample-model",
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

function renderToolbar(input: {
  readonly presentation: boolean;
  readonly runTargetHostId: string | null;
  readonly onSubmit: () => void;
}) {
  return render(
    <TooltipProvider>
      <ComposerTileIdProvider tileId={TILE}>
        <ComposerToolbar
          presentation={input.presentation}
          store={toolbarStore()}
          onAttachImages={() => undefined}
          canSubmit
          attachmentPending={false}
          onSubmit={input.onSubmit}
          activeTurnStatus={null}
          stopDisabled={false}
          onStopTurn={null}
          composerDisabledHint={null}
          dictation={null}
          dictationPreparing={null}
          settingsLocked={false}
          createProfileHostId={null}
          runTargetHostId={input.runTargetHostId}
          terminalLoginSurface={null}
          chatLineCarriesAutoMode={null}
        />
      </ComposerTileIdProvider>
    </TooltipProvider>,
  );
}

function sendButton(): HTMLButtonElement {
  const button = screen
    .getByTestId("toolbar-item-send")
    .querySelector("button");
  if (button === null) throw new Error("no send button");
  return button;
}

beforeEach(() => {
  hostHooks.schemaVersion.mockClear();
  hostHooks.judgeBilling.mockClear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});
afterEach(cleanup);

describe("ComposerToolbar presentation mode", () => {
  it("never calls the host hooks the live toolbar uses", () => {
    renderToolbar({
      presentation: true,
      runTargetHostId: "host-a",
      onSubmit: vi.fn(),
    });

    expect(hostHooks.schemaVersion).not.toHaveBeenCalled();
    expect(hostHooks.judgeBilling).not.toHaveBeenCalled();
  });

  it("control: the live toolbar DOES call them", () => {
    renderToolbar({
      presentation: false,
      runTargetHostId: "host-a",
      onSubmit: vi.fn(),
    });

    expect(hostHooks.schemaVersion).toHaveBeenCalledWith(
      "host-a",
      "agent.gui.listHarnesses",
    );
    expect(hostHooks.judgeBilling).toHaveBeenCalled();
    expect(screen.getByTestId("live-model-picker-stub")).not.toBeNull();
  });

  it("draws the sample model trigger instead of querying a catalog", () => {
    renderToolbar({
      presentation: true,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });

    expect(screen.queryByTestId("live-model-picker-stub")).toBeNull();
    expect(screen.getByText("Sample model")).not.toBeNull();
  });

  // L-131. The presentation toolbar used to be `inert`, which removed the whole
  // strip from hit testing - and the one surface that renders it is the layout
  // editor's canvas, where Attach image, Access, Agent, Model and Microphone
  // are exactly what the user points at. Passivity is the leaves' own (the
  // assertions below) plus the edit firewall on the app column; it is never a
  // subtree the pointer cannot reach.
  it("is pointable in presentation mode: nothing in the strip is inert", () => {
    const { container, unmount } = renderToolbar({
      presentation: true,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });
    expect(container.querySelector("[inert]")).toBeNull();
    unmount();

    const live = renderToolbar({
      presentation: false,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });
    expect(live.container.querySelector("[inert]")).toBeNull();
  });

  /**
   * L-129. The presentation copy used to be handed back without its cluster
   * menu at all ("it is a picture"), which is backwards: the sample
   * workspace's toolbar is the ONE toolbar the user right-clicks while
   * customizing, and a quick verb there writes the same value the inspector's
   * own control writes.
   */
  it("answers a right-click with the pointed-at item's quick verbs", () => {
    renderToolbar({
      presentation: true,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });

    const attach = document.querySelector('[data-layout-region="attachImage"]');
    if (attach === null) throw new Error("attach image region is not named");
    fireEvent.contextMenu(attach);

    expect(
      screen.queryByTestId("layout-quick-verb-attachImage-hide"),
    ).not.toBeNull();
    expect(screen.queryByTestId("customize-layout-menu-item")).not.toBeNull();
  });

  it("registers no active-model-picker activation", () => {
    renderToolbar({
      presentation: true,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });

    expect(getActiveModelPicker()).toBeNull();
  });

  it("send is disabled and clicking it never submits, even with canSubmit", () => {
    const onSubmit = vi.fn();
    renderToolbar({ presentation: true, runTargetHostId: null, onSubmit });

    const send = sendButton();
    expect(send.disabled || send.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("control: the live toolbar's send is enabled when canSubmit", () => {
    const onSubmit = vi.fn();
    renderToolbar({ presentation: false, runTargetHostId: null, onSubmit });

    const send = sendButton();
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
