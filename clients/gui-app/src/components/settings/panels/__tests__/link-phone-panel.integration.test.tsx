/**
 * Real-cache integration for the dead-code restart: a REAL QueryClient and
 * the real watch/code/status hooks (only the AuthService seam and the
 * respond mutation are faked). Pins the mechanism the mocked-hook suite
 * cannot: after another surface supersedes the displayed code, "Show a new
 * code here" must EVICT the mint entry and re-enable the query so a SECOND
 * mint fires and a genuinely fresh code renders — a bare refetch (or a
 * key-switched placeholder query) leaves the panel dead.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    mintLinkLoginCode: vi.fn(),
    fetchLinkLoginStatus: vi.fn(),
  },
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({ auth: mocks.auth }),
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (
    selector: (state: {
      status: string;
      contextMetadata: { userId: string };
    }) => unknown,
  ) => selector({ status: "signed-in", contextMetadata: { userId: "user-1" } }),
}));

vi.mock("@/hooks/auth/use-respond-link-login-mutation", () => ({
  useRespondLinkLoginMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  // The panel encodes the QR against the shell's own platform origin, taken
  // from `signInUrl`. Without one the tile draws a placeholder instead of a
  // symbol - deliberately, so a build that cannot name its deployment never
  // puts a live code in front of a camera - which is not the state these
  // tests are about.
  useRunnerHost: () => ({ signInUrl: "https://platform.test/sign-in" }),
}));

import { LinkPhonePanel } from "../link-phone-panel";

describe("LinkPhonePanel against a real query cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("show-new after supersession mints a SECOND code and renders it", async () => {
    const codes = ["AAAAA-AAAAA", "BBBBB-BBBBB"];
    let mintCalls = 0;
    const deadCodes = new Set<string>();
    mocks.auth.mintLinkLoginCode.mockImplementation(() => {
      const code = codes[Math.min(mintCalls, codes.length - 1)];
      mintCalls += 1;
      return Promise.resolve({
        kind: "ok",
        response: {
          code,
          expires_in: 60,
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      });
    });
    mocks.auth.fetchLinkLoginStatus.mockImplementation((code: string) =>
      Promise.resolve(
        deadCodes.has(code)
          ? { kind: "gone" }
          : {
              kind: "ok",
              response: { status: "unclaimed", claimant: null },
            },
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <LinkPhonePanel />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText("AAAAA-AAAAA")).toBeTruthy();
    expect(mintCalls).toBe(1);

    // Another surface supersedes the displayed code.
    deadCodes.add("AAAAA-AAAAA");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(screen.getByTestId("link-phone-superseded")).toBeTruthy();

    // Several status cycles pass: no unprompted mint, rotation is idle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mintCalls).toBe(1);

    // The explicit user action mints a genuinely FRESH code and renders it.
    act(() => {
      screen.getByTestId("link-phone-show-new").click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mintCalls).toBe(2);
    expect(screen.getByText("BBBBB-BBBBB")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-superseded")).toBeNull();
    expect(screen.queryByTestId("link-phone-rejected-elsewhere")).toBeNull();
  });
});
