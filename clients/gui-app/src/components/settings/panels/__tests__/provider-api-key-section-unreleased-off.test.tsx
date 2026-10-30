/**
 * The build without environments (`unreleased-features.ts`) words the lines
 * under the key field as the release before them did: one line, the shell's
 * key or the stored one.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/hooks/providers/use-providers-set-api-key-mutation", () => ({
  useProvidersSetApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/providers/use-providers-clear-api-key-mutation", () => ({
  useProvidersClearApiKey: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { ProviderApiKeySection } from "@/components/settings/panels/provider-api-key-section";

function cursorState(source: "env" | "stored"): ProviderCliState {
  return {
    providerId: "cursor",
    enabled: true,
    disabledBy: null,
    selected: { kind: "path" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: true, configured: true, source },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    profiles: [],
  };
}

function renderSection(state: ProviderCliState): void {
  render(
    <ProviderApiKeySection
      state={state}
      draft=""
      onDraftChange={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("<ProviderApiKeySection /> without environments", () => {
  it("says only that the key comes from the shell environment when it does", () => {
    renderSection(cursorState("env"));

    expect(
      screen.getByText(
        "Using CURSOR_API_KEY from your shell environment. Save a key here to override it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Stored encrypted/)).toBeNull();
  });

  it("says a stored key is encrypted on this device and falls back to the shell's", () => {
    renderSection(cursorState("stored"));

    expect(
      screen.getByText(
        "Stored encrypted on this device. Falls back to CURSOR_API_KEY from your shell when unset.",
      ),
    ).toBeTruthy();
  });
});
