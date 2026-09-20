import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerTileIdProvider } from "@/components/home/composer/composer-tile-context";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

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
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  useCustomizeStore.setState({ session: null, instances: new Map() });
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

  it("makes the toolbar row inert, but only in presentation mode", () => {
    const { container, unmount } = renderToolbar({
      presentation: true,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });
    expect(container.querySelector("[inert]")).not.toBeNull();
    expect(
      screen.getByTestId("toolbar-item-send").closest("[inert]"),
    ).not.toBeNull();
    unmount();

    const live = renderToolbar({
      presentation: false,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });
    expect(live.container.querySelector("[inert]")).toBeNull();
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

  it("still registers the toolbar hotspots (model included) while a session is live", () => {
    act(() => {
      useCustomizeStore.setState({
        session: { scene: "sample", opener: { kind: "none" }, startedAt: 0 },
        instances: new Map(),
        history: { past: [], future: [] },
        announcement: "",
      });
    });
    renderToolbar({
      presentation: true,
      runTargetHostId: null,
      onSubmit: vi.fn(),
    });

    const keys = [...useCustomizeStore.getState().instances.keys()];
    expect(keys).toEqual(
      expect.arrayContaining([
        `composer.model@shell:${TILE}`,
        `composer.access@shell:${TILE}`,
        `composer.attachImage@shell:${TILE}`,
      ]),
    );
  });
});
