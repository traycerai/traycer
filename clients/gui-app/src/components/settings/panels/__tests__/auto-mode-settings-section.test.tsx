import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoModeSettingsSection } from "@/components/settings/panels/auto-mode-settings-section";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";

// Only `useHostScope` needs faking here: `useHostSupportsMethod` is left as
// the REAL hook reading the (empty, in a test) negotiated-manifest registry,
// which is exactly the "no negotiated manifest" default this test is about.
// Faking that registry to also cover the positive (methods advertised) half
// would mean standing up the host client, a QueryClientProvider and mocks for
// four RPC hooks (`useAutoJudgeQuery`/`SetMutation`,
// `useAutoPolicyQuery`/`SetMutation`) behind `HostRuntimeContext` - well past
// the ~30-line budget for this suite, so only the negative half is covered
// here; see the report back to the assigning agent for the positive-half gap.
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));

afterEach(() => {
  cleanup();
});

describe("<AutoModeSettingsSection />", () => {
  it("renders nothing when the host advertises neither autoJudge.get nor autoPolicy.get", () => {
    // The negotiated-manifest registry starts empty in a test, which is
    // exactly the state a host that predates auto mode - or one this window
    // has not yet handshaken with - leaves it in.
    const { container } = render(<AutoModeSettingsSection />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("auto-judge-picker")).toBeNull();
    expect(screen.queryByText("Auto mode policy")).toBeNull();
    expect(screen.queryByText("Auto mode judge")).toBeNull();
    expect(screen.queryByText("Auto mode")).toBeNull();
  });
});
