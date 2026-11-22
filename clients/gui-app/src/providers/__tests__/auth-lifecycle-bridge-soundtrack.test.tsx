/**
 * The soundtrack at an identity change: the real `EpicSessionLifecycleBridge`
 * ends the open session on sign-out and on a user switch, and the person's
 * wish stays set for the next account's first gesture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import {
  openedFakePorts,
  resetFakePorts,
} from "@/lib/soundtrack/__tests__/fake-ports";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";

vi.mock("@/lib/soundtrack/web-audio-ports", async () => {
  const { openFakePorts } =
    await import("@/lib/soundtrack/__tests__/fake-ports");
  return { openWebAudioPorts: openFakePorts };
});

function signIn(email: string, userId: string): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
    });
  });
}

function signOut(): void {
  act(() => {
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });
}

function startSession(): void {
  useSettingsStore.setState({ soundtrackEnabled: true });
  useSoundtrackStore.getState().enable();
  expect(useSoundtrackStore.getState().enabled).toBe(true);
}

beforeEach(() => {
  resetFakePorts();
  signIn("alice@example.com", "user-alice");
  render(
    <EpicSessionLifecycleBridge>
      <div />
    </EpicSessionLifecycleBridge>,
  );
});

afterEach(() => {
  cleanup();
  useSoundtrackStore.getState().disable();
  useSettingsStore.setState({ soundtrackEnabled: false });
  signOut();
});

describe("the soundtrack at an identity change", () => {
  it("ends the session on sign-out and leaves the wish set", () => {
    startSession();

    signOut();

    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().soundtrackEnabled).toBe(true);
  });

  it("ends the session on a user switch and leaves the wish set", () => {
    startSession();

    signIn("bob@example.com", "user-bob");

    expect(useSoundtrackStore.getState().enabled).toBe(false);
    expect(openedFakePorts[0].close).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().soundtrackEnabled).toBe(true);
  });
});
