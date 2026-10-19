import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSetupGuidance } from "@/lib/providers/provider-setup-guidance";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";

/**
 * The picker's "Set up in terminal" button, on both surfaces. A terminal
 * sign-in is a credential flow, so on a host that takes none (a sandbox) the
 * button is disabled and the refusal replaces the usual hint.
 */

const mocks = vi.hoisted(() => ({
  epicStart: vi.fn(),
  landingStart: vi.fn(),
  /** What both hooks report as `credentialRefusal`. */
  credentialRefusal: null as string | null,
  isPending: false,
}));

vi.mock("@/hooks/providers/use-provider-terminal-login", () => ({
  useProviderTerminalLogin: () => ({
    start: mocks.epicStart,
    isPending: mocks.isPending,
    credentialRefusal: mocks.credentialRefusal,
  }),
}));
vi.mock("@/hooks/providers/use-landing-provider-terminal-login", () => ({
  useLandingProviderStartTerminalLogin: () => ({
    start: mocks.landingStart,
    isPending: mocks.isPending,
    credentialRefusal: mocks.credentialRefusal,
  }),
}));

import { ProviderSetupTerminalAction } from "@/components/home/pickers/provider-setup-terminal-action";

const REFUSAL = "Sandboxes don't take sign-ins";
const HINT = "Reasonix asks for your key in that terminal.";

const GUIDANCE: ProviderSetupGuidance = {
  summary: "Reasonix keeps keys in its own store.",
  stepsAfterAction: ["Refresh this list."],
  noSurfaceStep: "Choose Set up in terminal from a model picker.",
  epicOnlyStep: "Open a chat first.",
  manualCommand: "reasonix setup",
  terminalActionLabel: "Set up in terminal",
  terminalHint: HINT,
};

const EPIC_SURFACE: ProviderTerminalLoginSurface = {
  kind: "epic",
  epicId: "epic-1",
  viewTabId: "tab-1",
};

function landingSurface(): ProviderTerminalLoginSurface {
  return { kind: "landing", resolveLandingPageId: () => "draft-1" };
}

function renderAction(
  surface: ProviderTerminalLoginSurface,
  onBeforeStart: () => void,
): void {
  render(
    <ProviderSetupTerminalAction
      providerId="reasonix"
      guidance={GUIDANCE}
      surface={surface}
      runTargetHostId="host-1"
      onBeforeStart={onBeforeStart}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.credentialRefusal = null;
  mocks.isPending = false;
});

describe("<ProviderSetupTerminalAction />", () => {
  it.each([
    ["epic", EPIC_SURFACE],
    ["landing", landingSurface()],
  ])(
    "on the %s surface, disables the button and shows the refusal in place of the hint when the host takes no credentials",
    (_label, surface) => {
      mocks.credentialRefusal = REFUSAL;
      const onBeforeStart = vi.fn();
      renderAction(surface, onBeforeStart);

      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Set up in terminal",
      });
      expect(button.disabled).toBe(true);
      expect(screen.getByText(REFUSAL)).toBeDefined();
      expect(screen.queryByText(HINT)).toBeNull();

      fireEvent.click(button);

      expect(onBeforeStart).not.toHaveBeenCalled();
      expect(mocks.epicStart).not.toHaveBeenCalled();
      expect(mocks.landingStart).not.toHaveBeenCalled();
    },
  );

  it("control, epic: on a host that takes sign-ins the button is live, shows the hint, and starts the login after onBeforeStart", () => {
    const onBeforeStart = vi.fn();
    renderAction(EPIC_SURFACE, onBeforeStart);

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Set up in terminal",
    });
    expect(button.disabled).toBe(false);
    expect(screen.getByText(HINT)).toBeDefined();
    expect(screen.queryByText(REFUSAL)).toBeNull();

    fireEvent.click(button);

    expect(onBeforeStart).toHaveBeenCalledTimes(1);
    expect(mocks.epicStart).toHaveBeenCalledTimes(1);
  });

  it("control, landing: the start page resolves its draft id and starts the login with it", () => {
    renderAction(landingSurface(), vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "Set up in terminal" }));

    expect(mocks.landingStart).toHaveBeenCalledWith("draft-1");
  });
});
