import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast, Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportSentChatMessage } from "@/components/share-on-x/sent-messages";
import { ShareOnXController } from "@/components/share-on-x/share-on-x-controller";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useShareOnXNudgeStore } from "@/stores/settings/share-on-x-nudge-store";

vi.mock("@/components/share-on-x/share-on-x-dialog", () => ({
  ShareOnXDialog: (props: { readonly epicId: string }) => (
    <div data-testid="share-dialog">{props.epicId}</div>
  ),
}));

const DAY_MS = 24 * 60 * 60 * 1_000;
const START = Date.UTC(2026, 0, 1);

function resetStores(): void {
  window.localStorage.clear();
  useAuthStore.setState({ status: "signed-in" });
  useOnboardingStore.setState({ completedAt: START - 60 * DAY_MS, step: 0 });
  useOnboardingTourOpenStore.getState().setOpen(false);
  useFirstTaskGuideStore.getState().prepare();
  useShareOnXNudgeStore.setState({
    firstSeenAt: START - 30 * DAY_MS,
    optedOut: false,
    postedAt: null,
    countedShowings: 0,
    nextEligibleAt: 0,
  });
}

function installCaptureBridge(): void {
  Reflect.set(globalThis, "runnerHost", {
    platform: { window: { captureRegion: vi.fn(() => Promise.resolve(null)) } },
  });
}

function mountController(): void {
  render(
    <>
      <Toaster />
      <ShareOnXController />
    </>,
  );
}

function sendMessage(text: string): void {
  act(() => {
    void reportSentChatMessage(true, { text, epicId: "e1", hostId: null });
  });
}

/**
 * Advance the fake clock in short steps, each in its own `act`: sonner's
 * mount and exit are chains of frames and timeouts that each need a render in
 * between, which a single `act` would hold back until it ends.
 */
async function settle(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

describe("<ShareOnXController />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    resetStores();
    installCaptureBridge();
  });
  afterEach(() => {
    // Sonner replays its active toasts to the next Toaster that mounts.
    toast.dismiss();
    cleanup();
    Reflect.deleteProperty(globalThis, "runnerHost");
    resetStores();
    vi.useRealTimers();
  });

  it("asks after a thank-you", async () => {
    mountController();
    sendMessage("thanks!");
    await settle(100);

    expect(screen.getByTestId("share-nudge-toast")).toBeTruthy();
  });

  it("stays quiet for a message that is not a thank-you", async () => {
    mountController();
    sendMessage("please also add tests");
    await settle(100);

    expect(screen.queryByTestId("share-nudge-toast")).toBeNull();
  });

  it("stays quiet while the install's cooldown is running", async () => {
    useShareOnXNudgeStore.setState({ nextEligibleAt: START + DAY_MS });
    mountController();
    sendMessage("thanks!");
    await settle(100);

    expect(screen.queryByTestId("share-nudge-toast")).toBeNull();
  });

  it("stays quiet where the window cannot be captured", async () => {
    Reflect.deleteProperty(globalThis, "runnerHost");
    mountController();
    sendMessage("thanks!");
    await settle(100);

    expect(screen.queryByTestId("share-nudge-toast")).toBeNull();
  });

  it("records an opt-out from Don't ask again", async () => {
    mountController();
    sendMessage("thanks!");
    await settle(100);

    fireEvent.click(screen.getByRole("button", { name: "Don't ask again" }));
    await settle(1_000);

    expect(useShareOnXNudgeStore.getState().optedOut).toBe(true);
    expect(screen.queryByTestId("share-nudge-toast")).toBeNull();
  });

  it("records a timeout when the countdown runs out", async () => {
    mountController();
    sendMessage("thanks!");
    await settle(100);
    const claimedUntil = useShareOnXNudgeStore.getState().nextEligibleAt;

    await settle(11_000);

    const state = useShareOnXNudgeStore.getState();
    expect(state.nextEligibleAt).toBeGreaterThanOrEqual(
      START + 10_000 + 3 * DAY_MS,
    );
    expect(state.nextEligibleAt).toBeGreaterThan(claimedUntil);
    expect(state.countedShowings).toBe(0);
    expect(state.optedOut).toBe(false);
    expect(screen.queryByTestId("share-nudge-toast")).toBeNull();
  });

  it("opens the share dialog for the chat's task from Share on X", async () => {
    mountController();
    sendMessage("thanks!");
    await settle(100);

    fireEvent.click(screen.getByRole("button", { name: /Share on X/ }));
    await settle(1_000);

    expect(screen.getByTestId("share-dialog").textContent).toBe("e1");
    expect(screen.queryByTestId("share-nudge-toast")).toBeNull();
  });
});
