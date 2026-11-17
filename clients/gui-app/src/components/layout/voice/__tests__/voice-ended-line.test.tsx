import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";
import { VoiceOutcomeLine } from "../voice-ended-line";

// The OS handoff and the shell are external boundaries; the lines are real.
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
  useRunnerHost: () => ({ openMicrophoneSettings: () => Promise.resolve() }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/hooks/auth/use-platform-billing-url", () => ({
  usePlatformBillingUrl: () => "https://billing.invalid/",
}));

const CONFIRM_LINE =
  "We couldn't confirm the call's voice. Please start a new call.";
const CHANGED_LINE =
  "The call's sign-in session changed. Start a new call to continue.";
const UNAVAILABLE_LINE =
  "This call's voice is no longer available. Start a new call to choose another.";

beforeEach(() => {
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
});
afterEach(cleanup);

function outcomeLine(): string | null {
  return screen.getByTestId("voice-outcome-line").textContent;
}

describe("the voice outcome lines", () => {
  it("says a refused opening could not confirm the call's voice", () => {
    useVoiceSessionStore.setState({ refusal: "voice-unconfirmed" });
    render(<VoiceOutcomeLine surface="composer" />);

    expect(outcomeLine()).toBe(CONFIRM_LINE);
    expect(screen.getByTestId("voice-outcome").dataset["state"]).toBe(
      "refused",
    );
  });

  it("says an ended call could not confirm its voice", () => {
    useVoiceSessionStore.setState({ endReason: "voice-unconfirmed" });
    render(<VoiceOutcomeLine surface="composer" />);

    expect(outcomeLine()).toBe(CONFIRM_LINE);
    expect(screen.getByTestId("voice-outcome").dataset["state"]).toBe("ended");
  });

  it("says an ended call's voice is no longer available", () => {
    useVoiceSessionStore.setState({ endReason: "voice-unavailable" });
    render(<VoiceOutcomeLine surface="composer" />);

    expect(outcomeLine()).toBe(UNAVAILABLE_LINE);
  });

  it("says a refused opening's sign-in session changed", () => {
    useVoiceSessionStore.setState({ refusal: "session-changed" });
    render(<VoiceOutcomeLine surface="composer" />);

    expect(outcomeLine()).toBe(CHANGED_LINE);
    expect(screen.getByTestId("voice-outcome").dataset["state"]).toBe(
      "refused",
    );
  });

  it("says an ended call's sign-in session changed", () => {
    useVoiceSessionStore.setState({ endReason: "session-changed" });
    render(<VoiceOutcomeLine surface="composer" />);

    expect(outcomeLine()).toBe(CHANGED_LINE);
    expect(screen.getByTestId("voice-outcome").dataset["state"]).toBe("ended");
  });

  it("keeps its own line for a real account switch", () => {
    useVoiceSessionStore.setState({ endReason: "account" });
    render(<VoiceOutcomeLine surface="composer" />);

    expect(outcomeLine()).toBe("Call ended when you switched accounts.");
  });

  it("says calls are not available when the deployment offers none", () => {
    useVoiceSessionStore.setState({ refusal: "calls-unavailable" });
    render(<VoiceOutcomeLine surface="composer" />);

    expect(outcomeLine()).toBe("Calls are not available right now.");
    expect(screen.getByTestId("voice-outcome").dataset["state"]).toBe(
      "refused",
    );
  });
});
