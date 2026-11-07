/**
 * The Record session row of the Sounds page, drawn by the real settings
 * section, through the real settings and soundtrack stores, behind a fake audio
 * device whose capture never answers and a fake desktop save channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SoundtrackSettingsSection } from "@/components/settings/panels/soundtrack-settings-section";
import { Toaster } from "@/components/ui/sonner";
import { FakeLockManager } from "@/lib/soundtrack/__tests__/fake-locks";
import { holdSoundtrackSessionLock } from "@/lib/soundtrack/session-lock";
import { AQUILO_1 } from "@/lib/soundtrack/__tests__/aquilo-1";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return {
    openWebAudioPorts: (...args: Parameters<typeof openFakePorts>) => ({
      ...openFakePorts(...args),
      captureMix: () => new Promise<never>(() => undefined),
    }),
  };
});

const DEV_MANIFEST = {
  version: 1,
  tracks: [AQUILO_1],
  views: { home: ["aquilo-1"], task: [], bot: [], settings: [] },
  stems: {
    tracks: [
      {
        name: "aquilo-1",
        layers: AQUILO_1.layers.map((layer) => ({
          name: layer.name,
          files: Array.from(
            { length: layer.variants ?? 0 },
            (_, index) =>
              `stems/aquilo-1/${layer.name}-${String(index + 1)}.ogg`,
          ),
        })),
      },
    ],
  },
};

type Opened = { readonly kind: "refused" };
// Never answers until the test ends, so a recording stays as started.
const unanswered: ((answer: Opened) => void)[] = [];
const open = vi.fn<(quality: string) => Promise<Opened>>();
const reveal = vi.fn<(recordingId: string) => Promise<boolean>>();
const channel = {
  open,
  append: () => Promise.resolve({ kind: "ok" }),
  close: () => Promise.resolve({ kind: "ok" }),
  reveal,
  onFinishRequested: () => () => undefined,
};

beforeEach(() => {
  resetFakePorts();
  open.mockReset().mockImplementation(
    () =>
      new Promise<Opened>((resolve) => {
        unanswered.push(resolve);
      }),
  );
  reveal.mockReset().mockResolvedValue(true);
  window.localStorage.clear();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useSoundtrackStore.setState({ recording: { kind: "off" }, paused: false });
  vi.stubEnv("MODE", "development");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(DEV_MANIFEST))),
  );
  vi.stubGlobal("runnerHost", { soundtrackRecording: channel });
});

afterEach(async () => {
  cleanup();
  Reflect.deleteProperty(navigator, "locks");
  useSoundtrackStore.getState().disable();
  // A recording still opening would stay the store's, and block the next one.
  for (const answer of unanswered.splice(0)) answer({ kind: "refused" });
  await vi.waitFor(() => {
    expect(useSoundtrackStore.getState().recording.kind).not.toBe("saving");
  });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function renderSection(): void {
  const client = new QueryClient();
  const wrap = (children: ReactNode): ReactNode => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrap(<SoundtrackSettingsSection />));
}

async function openSession(): Promise<void> {
  useSettingsStore.setState({ soundtrackEnabled: true });
  useSoundtrackStore.getState().enable();
  await vi.waitFor(() => {
    expect(openedFakePorts).toHaveLength(1);
  });
}

function disabledOf(name: string, role: "switch" | "combobox"): boolean {
  return screen.getByRole(role, { name }).hasAttribute("disabled");
}

const SAVED = {
  kind: "saved",
  recordingId: "rec-7",
  name: "session-2026-11-06-1722.webm",
  durationSeconds: 192,
  problem: null,
} as const;

describe("the Record session row", () => {
  it.each([
    ["no bridge at all", undefined],
    ["an older bridge without the member", {}],
    ["a bridge whose build cannot record", { soundtrackRecording: null }],
  ])("is not drawn with %s", (_name, host) => {
    vi.stubGlobal("runnerHost", host);
    renderSection();

    expect(screen.getByRole("switch", { name: "Music" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Record session" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Quality" })).toBeNull();
  });

  it("is drawn with the member, its switch held until this window has a session", async () => {
    renderSection();
    expect(screen.getByRole("combobox", { name: "Stop after" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Quality" })).toBeTruthy();
    expect(disabledOf("Record session", "switch")).toBe(true);
    expect(screen.getByText("Turn on Music to record.")).toBeTruthy();

    await openSession();

    expect(disabledOf("Record session", "switch")).toBe(false);
  });

  it("holds the two choices while it records and shows elapsed of the limit", async () => {
    renderSection();
    await openSession();
    expect(disabledOf("Stop after", "combobox")).toBe(false);
    expect(disabledOf("Quality", "combobox")).toBe(false);
    await userEvent.click(screen.getByRole("combobox", { name: "Stop after" }));
    await userEvent.click(screen.getByRole("option", { name: "30 minutes" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Quality" }));
    await userEvent.click(screen.getByRole("option", { name: "Lossless" }));

    await userEvent.click(
      screen.getByRole("switch", { name: "Record session" }),
    );

    expect(screen.getByText("Recording, 0:00 of 30:00.")).toBeTruthy();
    expect(disabledOf("Stop after", "combobox")).toBe(true);
    expect(disabledOf("Quality", "combobox")).toBe(true);
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledWith("lossless");
    });
  });

  it("names the saved session after it stops, and Show in folder reveals it", async () => {
    renderSection();
    await openSession();
    useSoundtrackStore.setState({ recording: SAVED });

    expect(
      await screen.findByText(/Saved session-2026-11-06-1722\.webm, 3:12\./),
    ).toBeTruthy();
    expect(disabledOf("Stop after", "combobox")).toBe(false);

    await userEvent.click(
      screen.getByRole("button", { name: "Show in folder" }),
    );

    expect(reveal).toHaveBeenCalledExactlyOnceWith("rec-7");
  });

  it("spins Show in folder while it waits, and says so when the desktop cannot show the recording", async () => {
    let answer: (shown: boolean) => void = () => undefined;
    reveal.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    render(<Toaster />);
    renderSection();
    await openSession();
    useSoundtrackStore.setState({ recording: SAVED });
    const show = await screen.findByRole("button", { name: "Show in folder" });

    await userEvent.click(show);
    expect(show.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("soundtrack-recording-reveal-spinner"),
    ).toBeTruthy();

    act(() => {
      answer(false);
    });

    expect(await screen.findByText("Couldn't show the recording")).toBeTruthy();
    expect(
      screen.queryByTestId("soundtrack-recording-reveal-spinner"),
    ).toBeNull();
    expect(show.hasAttribute("disabled")).toBe(false);
  });

  it("keeps Stop after and Quality across a rehydrate", async () => {
    renderSection();
    await userEvent.click(screen.getByRole("combobox", { name: "Stop after" }));
    await userEvent.click(screen.getByRole("option", { name: "2 hours" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Quality" }));
    await userEvent.click(screen.getByRole("option", { name: "Lossless" }));
    const persisted = window.localStorage.getItem("traycer-gui-app:settings");
    if (persisted === null) throw new Error("expected persisted settings");

    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    expect(useSettingsStore.getState().soundtrackRecordingQuality).toBe(
      "compressed",
    );
    window.localStorage.setItem("traycer-gui-app:settings", persisted);
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState()).toMatchObject({
      soundtrackRecordingLimit: "2-hours",
      soundtrackRecordingQuality: "lossless",
    });
  });

  it("says another window is playing while this window waits for its turn, and offers the switch once the turn comes", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: new FakeLockManager(),
    });
    // Another window holds the session.
    const other = holdSoundtrackSessionLock();
    useSettingsStore.setState({ soundtrackEnabled: true });
    useSoundtrackStore.getState().enable();
    renderSection();

    expect(
      await screen.findByText(
        "Another window is playing the music. Record from that window.",
      ),
    ).toBeTruthy();
    expect(disabledOf("Record session", "switch")).toBe(true);

    other.release();

    await vi.waitFor(() => {
      expect(disabledOf("Record session", "switch")).toBe(false);
    });
    expect(
      screen.queryByText(
        "Another window is playing the music. Record from that window.",
      ),
    ).toBeNull();
  });

  it("says Music is paused, with the switch held, when it launches paused with no session", async () => {
    useSettingsStore.setState({ soundtrackEnabled: true });
    useSettingsStore.setState({ soundtrackPaused: true });
    renderSection();

    expect(
      await screen.findByText("Music is paused. Play it to record."),
    ).toBeTruthy();
    expect(disabledOf("Record session", "switch")).toBe(true);
  });

  it("shows the row's description, not the paused line, and offers the switch when a session is open and paused", async () => {
    renderSection();
    await openSession();

    act(() => {
      useSettingsStore.setState({ soundtrackPaused: true });
      useSoundtrackStore.getState().setPaused(true);
    });

    expect(
      screen.getByText(
        "Saves the music, and why it changed, to this computer.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Music is paused. Play it to record."),
    ).toBeNull();
    expect(disabledOf("Record session", "switch")).toBe(false);
  });

  it("says another window is playing, not that Music is paused, when both are so", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: new FakeLockManager(),
    });
    // Held for the rest of the test: the window never gets its turn.
    holdSoundtrackSessionLock();
    useSettingsStore.setState({ soundtrackEnabled: true });
    useSettingsStore.setState({ soundtrackPaused: true });
    useSoundtrackStore.getState().enable();
    renderSection();

    expect(
      await screen.findByText(
        "Another window is playing the music. Record from that window.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Music is paused. Play it to record."),
    ).toBeNull();
  });

  it("starts a recording on a paused session, reads Recording paused, and reads Recording again after Play", async () => {
    renderSection();
    await openSession();
    await userEvent.click(screen.getByRole("combobox", { name: "Stop after" }));
    await userEvent.click(screen.getByRole("option", { name: "30 minutes" }));
    act(() => {
      useSettingsStore.setState({ soundtrackPaused: true });
      useSoundtrackStore.getState().setPaused(true);
    });
    expect(disabledOf("Record session", "switch")).toBe(false);

    await userEvent.click(
      screen.getByRole("switch", { name: "Record session" }),
    );

    expect(
      await screen.findByText("Recording paused, 0:00 of 30:00."),
    ).toBeTruthy();
    act(() => {
      useSettingsStore.setState({ soundtrackPaused: false });
      useSoundtrackStore.getState().setPaused(false);
    });
    expect(screen.getByText("Recording, 0:00 of 30:00.")).toBeTruthy();
  });

  it("rehydrates a quality and a limit the app does not know to the defaults", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: {
          soundtrackRecordingQuality: "flac",
          soundtrackRecordingLimit: "3-hours",
        },
        version: 1,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState()).toMatchObject({
      soundtrackRecordingQuality: "compressed",
      soundtrackRecordingLimit: "1-hour",
    });
  });
});
