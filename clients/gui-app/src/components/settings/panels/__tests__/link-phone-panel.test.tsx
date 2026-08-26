/**
 * The Link-a-phone panel under the server's one-live-code policy: the
 * countdown derives the next-mint moment from the mint response alone, the
 * displayed code is the ONLY watched code (a claim on it swaps the QR for
 * the confirmation card), a rejection resumes rotation with a fresh code,
 * and the one-time nature of a code is stated in copy.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useAuthLinkLoginCode: vi.fn(),
  useAuthLinkLoginStatus: vi.fn(),
  useRespondLinkLoginMutation: vi.fn(),
  evictLinkLoginCode: vi.fn(),
}));

vi.mock("@/hooks/auth/use-link-login-code-query", () => ({
  LINK_LOGIN_REMINT_MS: 50_000,
  useAuthLinkLoginCode: mocks.useAuthLinkLoginCode,
  useEvictLinkLoginCode: () => mocks.evictLinkLoginCode,
}));

vi.mock("@/hooks/auth/use-link-login-status-query", () => ({
  useAuthLinkLoginStatus: mocks.useAuthLinkLoginStatus,
}));

vi.mock("@/hooks/auth/use-respond-link-login-mutation", () => ({
  useRespondLinkLoginMutation: mocks.useRespondLinkLoginMutation,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: "signed-in" }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  // The panel encodes the QR against the shell's own platform origin, taken
  // from `signInUrl`. Without one the tile draws a placeholder instead of a
  // symbol - deliberately, so a build that cannot name its deployment never
  // puts a live code in front of a camera - which is not the state these
  // tests are about.
  useRunnerHost: () => ({ signInUrl: "https://platform.test/sign-in" }),
}));

import { LinkLoginMintError } from "@/lib/auth/link-login-mint-error";
import { LinkPhonePanel } from "../link-phone-panel";

function queryResultWithCode(nowMs: number) {
  return {
    isPending: false,
    isError: false,
    isRefetching: false,
    error: null,
    refetch: vi.fn(),
    data: {
      code: "ABCDE-FGHJK",
      expires_in: 60,
      expires_at: Math.floor(nowMs / 1000) + 60,
    },
  };
}

function statusResult(data: unknown) {
  return {
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    data,
  };
}

function respondIdle() {
  return { isPending: false, mutate: vi.fn() };
}

function claimedStatus(claimedAtMs: number, userAgent: string) {
  return {
    status: "claimed",
    claimant: {
      address: "192.168.29.87",
      userAgent,
      location: "Bengaluru, IN",
      claimedAt: claimedAtMs,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.useAuthLinkLoginStatus.mockReturnValue(statusResult(null));
  mocks.useRespondLinkLoginMutation.mockReturnValue(respondIdle());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("LinkPhonePanel", () => {
  it("counts down to the next mint from the shown code's expiry and ticks locally", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    render(<LinkPhonePanel />);
    // TTL 60s, rotation lead 10s -> the next code lands 50s after mint.
    expect(screen.getByTestId("link-phone-countdown").textContent).toBe(
      "New code in 50s",
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId("link-phone-countdown").textContent).toBe(
      "New code in 40s",
    );
    // The clock clamps at zero while the interval refetch is in flight.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("link-phone-countdown").textContent).toBe(
      "New code in 0s",
    );
  });

  it("watches only the displayed code; its claim swaps the QR for the confirmation and approves", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    const view = render(<LinkPhonePanel />);
    // The watch is on exactly the displayed code.
    const watched = mocks.useAuthLinkLoginStatus.mock.calls
      .map((call: unknown[]) => call[0])
      .filter((code): code is string => typeof code === "string");
    expect(new Set(watched)).toEqual(new Set(["ABCDE-FGHJK"]));

    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = respondIdle();
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    view.rerender(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-confirm")).toBeTruthy();
    expect(screen.getByTestId("link-phone-claimant").textContent).toContain(
      "192.168.29.87",
    );
    expect(screen.queryByTestId("link-phone-countdown")).toBeNull();
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    expect(respond.mutate).toHaveBeenCalledWith(
      { code: "ABCDE-FGHJK", approve: true },
      expect.anything(),
    );
  });

  it("a rejection resumes rotation with a fresh code", () => {
    const codeQuery = queryResultWithCode(Date.now());
    mocks.useAuthLinkLoginCode.mockReturnValue(codeQuery);
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          options.onSuccess("ok");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-reject").click();
    });
    expect(respond.mutate).toHaveBeenCalledWith(
      { code: "ABCDE-FGHJK", approve: false },
      expect.anything(),
    );
    // The rejected claim released the server's per-user lock; the panel
    // immediately requests a fresh code via the EVICTING restart (a bare
    // refetch could re-serve the dead entry from cache).
    expect(mocks.evictLinkLoginCode).toHaveBeenCalled();
  });

  it("rotation replaces the watched code with the newly displayed one", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "AAAAA-AAAAA", expires_in: 60, expires_at: 1 },
    });
    const view = render(<LinkPhonePanel />);
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: { code: "BBBBB-BBBBB", expires_in: 60, expires_at: 2 },
    });
    mocks.useAuthLinkLoginStatus.mockClear();
    view.rerender(<LinkPhonePanel />);
    // The superseded code is dead at the server; the committed render (the
    // adjust-during-render pass settles before commit) watches only B.
    const lastWatched = mocks.useAuthLinkLoginStatus.mock.calls
      .map((call: unknown[]) => call[0])
      .at(-1);
    expect(lastWatched).toBe("BBBBB-BBBBB");
    expect(screen.getByText("BBBBB-BBBBB")).toBeTruthy();
  });

  it("another surface's supersession renders as a state, never an unprompted mint", () => {
    const codeQuery = queryResultWithCode(Date.now());
    mocks.useAuthLinkLoginCode.mockReturnValue(codeQuery);
    const view = render(<LinkPhonePanel />);
    // The server reports the displayed code gone — another surface minted
    // over it. Rendered as the superseded state, never an automatic re-mint
    // (that would supersede the other surface right back, ping-ponging
    // mints until the rate limit).
    mocks.useAuthLinkLoginStatus.mockReturnValue(statusResult("gone"));
    view.rerender(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-superseded")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-countdown")).toBeNull();
    expect(codeQuery.refetch).not.toHaveBeenCalled();
    // Rotation idles while dead: a dead code costs zero further requests.
    const lastMintCall = mocks.useAuthLinkLoginCode.mock.calls.at(-1) as
      unknown[] | undefined;
    expect(lastMintCall?.[0]).toBe(false);
    // Only the explicit user action mints again — via the EVICTING restart
    // (a bare refetch would re-serve the dead entry from cache), which also
    // re-enables the mint query so the empty cache must fetch fresh.
    act(() => {
      screen.getByTestId("link-phone-show-new").click();
    });
    expect(mocks.evictLinkLoginCode).toHaveBeenCalledTimes(1);
    expect(codeQuery.refetch).not.toHaveBeenCalled();
    const reenabledCall = mocks.useAuthLinkLoginCode.mock.calls.at(-1) as
      unknown[] | undefined;
    expect(reenabledCall?.[0]).toBe(true);
  });

  it("an EXTERNAL rejection reads as rejected, with the same explicit restart", () => {
    const codeQuery = queryResultWithCode(Date.now());
    mocks.useAuthLinkLoginCode.mockReturnValue(codeQuery);
    const view = render(<LinkPhonePanel />);
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult({ status: "denied", claimant: null }),
    );
    view.rerender(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-rejected-elsewhere")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-superseded")).toBeNull();
    expect(codeQuery.refetch).not.toHaveBeenCalled();
    act(() => {
      screen.getByTestId("link-phone-show-new").click();
    });
    expect(mocks.evictLinkLoginCode).toHaveBeenCalledTimes(1);
    expect(codeQuery.refetch).not.toHaveBeenCalled();
  });

  it("claim-pending during rotation of a LIVE code keeps the QR — the claim may be its own", () => {
    // The rotation mint hit the claim lock while the displayed code's own
    // scan was landing: the next status poll surfaces it as the confirm
    // card. Flashing "awaiting elsewhere" over a live QR would be wrong.
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      isError: true,
      error: new LinkLoginMintError("claim-pending"),
    });
    render(<LinkPhonePanel />);
    expect(screen.queryByTestId("link-phone-awaiting-elsewhere")).toBeNull();
    expect(screen.getByTestId("link-phone-single-use-hint")).toBeTruthy();
  });

  it("gone → claim-pending renders the awaiting state, not a dead QR or an error", () => {
    // The displayed code is gone AND minting is refused because the user's
    // single live claim awaits the decision on another surface: the panel
    // must say so — not render the retained dead QR, not an error card.
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      isError: true,
      error: new LinkLoginMintError("claim-pending"),
    });
    mocks.useAuthLinkLoginStatus.mockReturnValue(statusResult("gone"));
    render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-awaiting-elsewhere")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-superseded")).toBeNull();
    expect(screen.queryByTestId("link-phone-countdown")).toBeNull();
    expect(screen.queryByTestId("link-phone-confirm")).toBeNull();
  });

  it("the pressed decision button owns the spinner; the other only disables", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    mocks.useRespondLinkLoginMutation.mockReturnValue({
      isPending: true,
      variables: { code: "ABCDE-FGHJK", approve: false },
      mutate: vi.fn(),
    });
    render(<LinkPhonePanel />);
    // The REJECT round-trip is in flight: its button spins, Approve does
    // not — it only disables.
    expect(screen.getByTestId("link-phone-reject-spinner")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-approve-spinner")).toBeNull();
    expect(
      screen.getByTestId("link-phone-approve").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("link-phone-reject").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("unknown claimant metadata is omitted, never admitted", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult({
        status: "claimed",
        claimant: {
          address: "192.168.29.246",
          userAgent: null,
          location: null,
          claimedAt: Date.now(),
        },
      }),
    );
    render(<LinkPhonePanel />);
    const line = screen.getByTestId("link-phone-claimant").textContent;
    expect(line).toBe("192.168.29.246 · just now");
    expect(line).not.toContain("unknown");
  });

  it("a claimed record expiring under an open confirm card swaps it for the expired state", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-confirm")).toBeTruthy();
    // The status poll is FROZEN (the mock never changes): the local claim
    // deadline alone must retire the card once the window + grace elapse —
    // never a card whose buttons act on a record the server deleted.
    act(() => {
      vi.advanceTimersByTime(140_000);
    });
    expect(screen.queryByTestId("link-phone-confirm")).toBeNull();
    expect(screen.getByTestId("link-phone-expired")).toBeTruthy();
    // No unprompted mint; only the explicit action restarts.
    expect(mocks.evictLinkLoginCode).not.toHaveBeenCalled();
    act(() => {
      screen.getByTestId("link-phone-show-new").click();
    });
    expect(mocks.evictLinkLoginCode).toHaveBeenCalledTimes(1);
  });

  it("responding on a dead code surfaces the restart, never silence", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          // The record died before the click landed: the server answers the
          // uniform not-found, surfaced as `gone`.
          options.onSuccess("gone");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    // Not the approved state — the evicting restart runs instead.
    expect(screen.queryByTestId("link-phone-approved")).toBeNull();
    expect(mocks.evictLinkLoginCode).toHaveBeenCalled();
  });

  it("a lost respond keeps the claim and says so, instead of re-minting", () => {
    // The decision never reached the server, so the phone is still waiting on
    // it. Silently swapping in a fresh QR would answer a network problem by
    // invalidating the code the user was mid-way through approving - and say
    // nothing about why.
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          options.onSuccess("failed");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });

    expect(screen.getByTestId("link-phone-respond-failed")).toBeTruthy();
    // The claim card is still up, so the same decision can simply be retaken.
    expect(screen.getByTestId("link-phone-confirm")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-approved")).toBeNull();
    expect(mocks.evictLinkLoginCode).not.toHaveBeenCalled();
  });

  it("a thrown respond is treated the same as a lost one", () => {
    // `onError` is the transport failing before the mutation ever produced an
    // outcome; the claim is no more spent than in the case above.
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onError: (error: Error) => void },
        ) => {
          options.onError(new Error("offline"));
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });

    expect(screen.getByTestId("link-phone-respond-failed")).toBeTruthy();
    expect(mocks.evictLinkLoginCode).not.toHaveBeenCalled();
  });

  it("does NOT report approval when the other surface already rejected", () => {
    // authn is idempotent per direction: the SAME decision replays as 200,
    // the OPPOSITE one is 409 `already_decided`. So Approve coming back
    // already-decided means a denial won - the phone was refused. Reporting
    // "signed in" here would be a false confirmation on the one decision in
    // this flow that is security-sensitive.
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          options.onSuccess("already-decided");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });

    expect(screen.queryByTestId("link-phone-approved")).toBeNull();
    const card = screen.getByTestId("link-phone-decided-elsewhere");
    expect(card.getAttribute("data-decision")).toBe("rejected");
    expect(card.textContent).toContain("No phone was signed in");
    // The code is spent whichever way it went, so it is retired.
    expect(mocks.evictLinkLoginCode).toHaveBeenCalled();
  });

  it("shows the replacement code after a decided-elsewhere card", () => {
    // The card REPLACED the Approve/Reject controls, so nothing else can
    // clear the state gating it. Without clearing it here the re-mint happens
    // behind a card that never goes away - the user is stuck on a dead end
    // with a fresh code they cannot see.
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          options.onSuccess("already-decided");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    const view = render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    expect(screen.getByTestId("link-phone-decided-elsewhere")).toBeTruthy();

    // The re-mint lands, but the SPENT claim is still in the status cache -
    // polls are two seconds apart, so this is the ordinary case, not a corner.
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: {
        code: "22222-33333",
        expires_in: 60,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      },
    });
    act(() => {
      screen.getByTestId("link-phone-decided-elsewhere-new").click();
    });
    act(() => {
      view.rerender(<LinkPhonePanel />);
      vi.advanceTimersByTime(2_100);
    });

    // The terminal card is gone, and the dead claim did NOT come back with it:
    // resurrecting it would put live Approve/Reject controls on a decision the
    // server has already settled.
    expect(screen.queryByTestId("link-phone-decided-elsewhere")).toBeNull();
    expect(screen.queryByTestId("link-phone-confirm")).toBeNull();

    // The stale status finally clears, and the replacement is what shows.
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult({ status: "unclaimed", claimant: null }),
    );
    act(() => {
      view.rerender(<LinkPhonePanel />);
      vi.advanceTimersByTime(2_100);
    });

    expect(screen.getByTestId("link-phone-qr-tile")).toBeTruthy();
    expect(screen.getByText("22222-33333")).toBeTruthy();
  });

  it("reports an approval that landed elsewhere as exactly that", () => {
    // The mirror: Reject answered second means an approval already won, and
    // that phone IS signed in. Saying "rejected" would be equally false.
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          options.onSuccess("already-decided");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-reject").click();
    });

    const card = screen.getByTestId("link-phone-decided-elsewhere");
    expect(card.getAttribute("data-decision")).toBe("approved");
    expect(card.textContent).toContain("That phone is signed in");
  });

  it("does not carry a failed decision's warning onto the next claim", () => {
    // The notice belongs to the code it happened on. A bare flag outlives
    // that claim, so the next phone's card would open already complaining
    // about a failure that was not its own.
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    const respond = {
      isPending: false,
      mutate: vi.fn(
        (
          _variables: { code: string; approve: boolean },
          options: { onSuccess: (outcome: string) => void },
        ) => {
          options.onSuccess("failed");
        },
      ),
    };
    mocks.useRespondLinkLoginMutation.mockReturnValue(respond);
    const view = render(<LinkPhonePanel />);
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    expect(screen.getByTestId("link-phone-respond-failed")).toBeTruthy();

    // Claim A goes away — decided elsewhere, or expired. Only with no claim
    // on screen does the watch hook follow a fresh mint, which is exactly the
    // real sequence: the card clears, a new code is shown, a new phone scans.
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult({ status: "unclaimed", claimant: null }),
    );
    act(() => {
      view.rerender(<LinkPhonePanel />);
      vi.advanceTimersByTime(2_100);
    });

    // A DIFFERENT phone claims a DIFFERENT code.
    mocks.useAuthLinkLoginCode.mockReturnValue({
      ...queryResultWithCode(Date.now()),
      data: {
        code: "22222-33333",
        expires_in: 60,
        expires_at: Math.floor(Date.now() / 1000) + 60,
      },
    });
    act(() => {
      view.rerender(<LinkPhonePanel />);
      vi.advanceTimersByTime(2_100);
    });
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
    );
    act(() => {
      view.rerender(<LinkPhonePanel />);
      vi.advanceTimersByTime(2_100);
    });

    expect(screen.getByTestId("link-phone-confirm")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-respond-failed")).toBeNull();
  });

  it("a self-reported device name renders verbatim on the card", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    mocks.useAuthLinkLoginStatus.mockReturnValue(
      statusResult(claimedStatus(Date.now(), "iPhone 16 Pro")),
    );
    render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-confirm").textContent).toContain(
      "Approve sign-in from iPhone 16 Pro?",
    );
  });

  it("states that a code is single-use and short-lived", () => {
    mocks.useAuthLinkLoginCode.mockReturnValue(queryResultWithCode(Date.now()));
    render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-single-use-hint").textContent).toBe(
      "Each code signs in one phone, expires in about a minute, and only takes effect once you approve it here.",
    );
    // The raw code stays available for the manual-entry path.
    expect(screen.getByText("ABCDE-FGHJK")).toBeTruthy();
  });
});
