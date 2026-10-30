import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ProfileSyncEntryButton } from "@/components/settings/panels/profile-sync/profile-sync-entry-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProfileSyncModalStore } from "@/stores/settings/profile-sync-modal-store";

const HOST_ID = "host-source";

// What `useHostCredentialRefusal` answers for the host; `null` is one that syncs.
const credentialHost = vi.hoisted(() => ({
  refusal: null as string | null,
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => credentialHost.refusal,
}));

function renderButton(
  hostId: string | null,
  providerId: "claude-code" | "codex" | "cursor",
): void {
  render(
    <TooltipProvider delayDuration={0}>
      <ProfileSyncEntryButton hostId={hostId} providerId={providerId} />
    </TooltipProvider>,
  );
}

describe("<ProfileSyncEntryButton />", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
    credentialHost.refusal = null;
    useProfileSyncModalStore.getState().close();
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    useProfileSyncModalStore.getState().close();
  });

  it("renders nothing when hostId is null", () => {
    renderButton(null, "claude-code");
    expect(screen.queryByRole("button", { name: "Sync profiles…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("renders nothing for a provider sync does not cover", () => {
    renderButton(HOST_ID, "cursor");
    expect(screen.queryByRole("button", { name: "Sync profiles…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("is disabled with the update tooltip when the host does not advertise overview", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.list": { major: 1, minor: 0 },
    });
    renderButton(HOST_ID, "claude-code");

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Sync profiles…",
    });
    expect(button.disabled).toBe(true);
    const trigger = button.parentElement;
    if (trigger === null)
      throw new Error("expected a tooltip trigger around the button");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Update Traycer on this device to sync profiles.",
    );
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("is disabled while method support is still unknown", () => {
    renderButton(HOST_ID, "codex");
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Sync profiles…",
    });
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("is enabled when overview is advertised, and clicking opens the modal store", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.profileSync.overview": { major: 1, minor: 0 },
    });
    renderButton(HOST_ID, "claude-code");

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Sync profiles…",
    });
    expect(button.disabled).toBe(false);
    act(() => {
      fireEvent.click(button);
    });
    expect(useProfileSyncModalStore.getState().sourceHostId).toBe(HOST_ID);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("is disabled with the refusal as its label, and never opens the modal, when the host takes no credentials", () => {
    credentialHost.refusal = "Sandboxes don't take sign-ins";
    // Overview IS advertised: only the refusal can be what holds it.
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.profileSync.overview": { major: 1, minor: 0 },
    });
    renderButton(HOST_ID, "claude-code");

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Sync profiles…",
    });
    expect(button.disabled).toBe(true);
    const trigger = button.parentElement;
    if (trigger === null)
      throw new Error("expected a tooltip trigger around the button");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Sandboxes don't take sign-ins",
    );

    act(() => {
      fireEvent.click(button);
    });
    expect(useProfileSyncModalStore.getState().sourceHostId).toBeNull();
  });
});
