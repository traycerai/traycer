import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useVoiceSessionStore,
  type VoiceSessionDriver,
} from "@/stores/voice/voice-session-store";
import { TalkControl } from "../talk-control";

const initial = useVoiceSessionStore.getState();

function makeDriver() {
  return {
    start: vi.fn<VoiceSessionDriver["start"]>(),
    end: vi.fn<VoiceSessionDriver["end"]>(),
    setMuted: vi.fn<VoiceSessionDriver["setMuted"]>(),
  };
}

function renderControl(): void {
  render(
    <TooltipProvider>
      <TalkControl compact={false} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
});

afterEach(cleanup);

describe("TalkControl", () => {
  it("renders nothing while voice is unknown or dormant, or no driver is mounted", () => {
    useVoiceSessionStore.setState({ driver: makeDriver() });
    useVoiceSessionStore.getState().setAvailability("dormant");
    renderControl();
    expect(screen.queryByRole("button", { name: "Talk" })).toBeNull();

    cleanup();
    useVoiceSessionStore.getState().setAvailability("unknown");
    renderControl();
    expect(screen.queryByRole("button", { name: "Talk" })).toBeNull();

    cleanup();
    useVoiceSessionStore.setState({ driver: null, availability: "live" });
    renderControl();
    expect(screen.queryByRole("button", { name: "Talk" })).toBeNull();
  });

  it("compact draws the glyph alone, named and working as before", async () => {
    const driver = makeDriver();
    useVoiceSessionStore.setState({ driver, availability: "live" });
    render(
      <TooltipProvider>
        <TalkControl compact />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: "Talk" });
    expect(button.textContent).toBe("");
    await userEvent.click(button);
    expect(driver.start).toHaveBeenCalledTimes(1);
  });

  it("starts a session when idle", async () => {
    const driver = makeDriver();
    useVoiceSessionStore.setState({ driver, availability: "live" });
    renderControl();

    await userEvent.click(screen.getByRole("button", { name: "Talk" }));

    expect(driver.start).toHaveBeenCalledTimes(1);
    expect(driver.end).not.toHaveBeenCalled();
  });

  it("is pressed while live and ends the session", async () => {
    const driver = makeDriver();
    useVoiceSessionStore.setState({
      driver,
      phase: "live",
      availability: "live",
    });
    renderControl();
    const button = screen.getByRole("button", { name: "Talk" });

    expect(button.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(button);

    expect(driver.end).toHaveBeenCalledTimes(1);
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("is disabled while connecting", () => {
    useVoiceSessionStore.setState({
      driver: makeDriver(),
      phase: "connecting",
      availability: "live",
    });
    renderControl();

    expect(
      screen.getByRole("button", { name: "Talk" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
