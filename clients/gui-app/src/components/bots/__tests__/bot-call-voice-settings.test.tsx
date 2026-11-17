import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotCallVoiceSettings } from "@/components/bots/bot-call-voice-settings";
import type { CallVoiceCatalogueState } from "@/lib/voice/call-voice";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";

const READY: CallVoiceCatalogueState = {
  kind: "ready",
  catalogue: {
    defaultVoice: "marin",
    voices: ["alloy", "cedar", "marin", "sage", "verse"],
  },
};
const WITHOUT_CEDAR: CallVoiceCatalogueState = {
  kind: "ready",
  catalogue: { defaultVoice: "marin", voices: ["alloy", "marin", "verse"] },
};
const IN_CALL_NOTE = "This call keeps its current voice.";

function reset(): void {
  window.localStorage.clear();
  useSettingsStore.setState({ callVoice: null });
  useVoiceSessionStore.setState(useVoiceSessionStore.getInitialState(), true);
}

function checkedOptions(): string[] {
  return screen
    .getAllByRole("option")
    .filter((o) => o.getAttribute("data-checked") === "true")
    .map((o) => o.textContent);
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

describe("BotCallVoiceSettings", () => {
  it("marks the default voice when nothing is saved, and offers no way to hear a voice", () => {
    render(<BotCallVoiceSettings catalogue={READY} />);

    expect(
      screen.getByRole("listbox", { name: "Voice for calls" }),
    ).toBeTruthy();
    expect(checkedOptions()).toEqual(["MarinDefault"]);
    expect(screen.getByText("Selected: Marin (default)")).toBeTruthy();
    expect(
      screen.getByText("Used on this device. Changes apply to the next call."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /preview|play|listen/i }),
    ).toBeNull();
  });

  it("filters the voices by a case-insensitive substring and says when none match", async () => {
    const user = userEvent.setup();
    render(<BotCallVoiceSettings catalogue={READY} />);
    const search = screen.getByRole("combobox");

    await user.type(search, "AR");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Cedar",
      "MarinDefault",
    ]);

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByText("No matching voices.")).toBeTruthy();
  });

  it("stores the chosen voice by its wire name, in the store and on this device, and follows it", async () => {
    const user = userEvent.setup();
    render(<BotCallVoiceSettings catalogue={READY} />);

    await user.click(screen.getByRole("option", { name: /Cedar/ }));

    expect(useSettingsStore.getState().callVoice).toBe("cedar");
    const persisted = JSON.parse(
      window.localStorage.getItem("traycer-gui-app:settings") ?? "null",
    ) as { state: { callVoice: string | null } };
    expect(persisted.state.callVoice).toBe("cedar");
    expect(screen.getByText("Selected: Cedar")).toBeTruthy();
    expect(checkedOptions()).toEqual(["Cedar"]);
  });

  it("names a saved voice that is no longer offered, keeps it saved, and checks the default", () => {
    useSettingsStore.setState({ callVoice: "cedar" });
    render(<BotCallVoiceSettings catalogue={WITHOUT_CEDAR} />);

    expect(screen.getByText("Saved: Cedar (unavailable)")).toBeTruthy();
    expect(
      screen.getByText("Cedar isn't available now, so calls use Marin."),
    ).toBeTruthy();
    expect(checkedOptions()).toEqual(["MarinDefault"]);
    expect(useSettingsStore.getState().callVoice).toBe("cedar");
  });

  it.each([
    [
      "unsupported",
      "Voice choices aren't available on this connection. Calls use the default voice.",
    ],
    ["failed", "Couldn't load voice choices."],
  ] as const)(
    "shows no choices when the catalogue is %s, and keeps the saved voice",
    (kind, copy) => {
      useSettingsStore.setState({ callVoice: "cedar" });
      render(<BotCallVoiceSettings catalogue={{ kind }} />);

      expect(screen.getByText(copy)).toBeTruthy();
      expect(screen.getByText("Saved: Cedar")).toBeTruthy();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(useSettingsStore.getState().callVoice).toBe("cedar");
    },
  );

  it("shows a busy indicator while the voices load, and keeps the saved voice", () => {
    useSettingsStore.setState({ callVoice: "cedar" });
    render(<BotCallVoiceSettings catalogue={{ kind: "loading" }} />);

    expect(
      screen.getByLabelText("Loading voices").getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.getByText("Saved: Cedar")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(useSettingsStore.getState().callVoice).toBe("cedar");
  });

  it("says a call in progress keeps its voice only while the call is connecting or live", () => {
    render(<BotCallVoiceSettings catalogue={READY} />);
    expect(screen.queryByText(IN_CALL_NOTE)).toBeNull();

    act(() => {
      useVoiceSessionStore
        .getState()
        .sessionConnecting(
          { botId: "bot-1", hostId: "host-1", threadId: null },
          "Tracy",
        );
    });
    expect(screen.getByText(IN_CALL_NOTE)).toBeTruthy();

    act(() => {
      useVoiceSessionStore.getState().sessionLive({
        id: "session-1",
        expiresAt: 0,
        engine: {
          connect: () => Promise.resolve(),
          appendCommentary: () => undefined,
          appendThinking: () => undefined,
          close: () => Promise.resolve(),
        },
      });
    });
    expect(screen.getByText(IN_CALL_NOTE)).toBeTruthy();

    act(() => {
      useVoiceSessionStore.getState().sessionEnded(null);
    });
    expect(screen.queryByText(IN_CALL_NOTE)).toBeNull();
  });
});
