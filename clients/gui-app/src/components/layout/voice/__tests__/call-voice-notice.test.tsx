import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";
import { CallVoiceNotice } from "../call-voice-notice";

beforeEach(() => {
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
});
afterEach(cleanup);

describe("the in-call voice notice", () => {
  it("names the voice that was asked for and the one the call uses, from the store, while the call is live", () => {
    useVoiceSessionStore.setState({
      phase: "live",
      voiceNotice: { kind: "fallback", saved: "cedar", voice: "marin" },
    });
    render(<CallVoiceNotice />);

    expect(
      screen.getByText("Cedar is unavailable. This call uses Marin."),
    ).toBeTruthy();
  });

  it("says a legacy connection uses the default voice", () => {
    useVoiceSessionStore.setState({
      phase: "connecting",
      voiceNotice: { kind: "legacy" },
    });
    render(<CallVoiceNotice />);

    expect(
      screen.getByText(
        "This connection uses the default voice; it may change when reconnecting.",
      ),
    ).toBeTruthy();
  });
});
