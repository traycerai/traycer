/**
 * What the Link-a-phone panel SHOWS for each state the watch reports: the
 * tile's frame drains with the same clock as the countdown text, a rotation
 * mounts a fresh tile, and every terminal state states plainly what happened
 * and what the user can do next. The watch itself is faked here — its
 * behaviour is covered by link-phone-panel.test.tsx, and duplicating it would
 * only pin the same logic twice.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkLoginMintError } from "@/lib/auth/link-login-mint-error";

const mocks = vi.hoisted(() => ({
  useLinkLoginWatch: vi.fn(),
  useRespondLinkLoginMutation: vi.fn(),
}));

vi.mock("@/hooks/auth/use-link-login-code-query", () => ({
  LINK_LOGIN_REMINT_MS: 50_000,
  useAuthLinkLoginCode: vi.fn(),
}));

vi.mock("@/hooks/auth/use-link-login-watch", () => ({
  useLinkLoginWatch: mocks.useLinkLoginWatch,
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

import { LinkPhonePanel } from "../link-phone-panel";

const REMINT_SECONDS = 50;

function codeQuery(overrides: {
  data: unknown;
  isError: boolean;
  error: unknown;
}) {
  return {
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function showing(nowMs: number, code: string) {
  return {
    claim: null,
    deadKind: null,
    code: codeQuery({
      data: { code, expires_in: 60, expires_at: Math.floor(nowMs / 1000) + 60 },
      isError: false,
      error: null,
    }),
  };
}

function remainingFraction(): number {
  return Number(
    screen
      .getByTestId("link-phone-expiry-frame")
      .getAttribute("data-remaining-fraction"),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.useRespondLinkLoginMutation.mockReturnValue({
    isPending: false,
    mutate: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("LinkPhonePanel presentation", () => {
  it("drains the tile's frame in step with the countdown text", () => {
    mocks.useLinkLoginWatch.mockReturnValue(showing(Date.now(), "ABCDE-FGHJK"));
    render(<LinkPhonePanel />);
    const secondsLeft = () =>
      screen.getByTestId("link-phone-countdown").textContent;

    expect(secondsLeft()).toBe(`New code in ${REMINT_SECONDS}s`);
    expect(remainingFraction()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(secondsLeft()).toBe("New code in 25s");
    expect(remainingFraction()).toBe(0.5);

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(secondsLeft()).toBe("New code in 5s");
    expect(remainingFraction()).toBe(0.1);

    // The frame empties with the clock and stays empty while the refetch is
    // in flight, rather than wrapping back around.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(secondsLeft()).toBe("New code in 0s");
    expect(remainingFraction()).toBe(0);
  });

  it("mounts a fresh tile when the code rotates", () => {
    mocks.useLinkLoginWatch.mockReturnValue(showing(Date.now(), "AAAAA-AAAAA"));
    const view = render(<LinkPhonePanel />);
    const first = screen.getByTestId("link-phone-qr-surface");
    expect(first.className).toContain("fade-in-0");

    mocks.useLinkLoginWatch.mockReturnValue(showing(Date.now(), "BBBBB-BBBBB"));
    view.rerender(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-qr-surface")).not.toBe(first);
    expect(screen.getByText("BBBBB-BBBBB")).toBeTruthy();
  });

  it("keeps the panel's shape while a code is being regenerated", () => {
    mocks.useLinkLoginWatch.mockReturnValue(showing(Date.now(), "ABCDE-FGHJK"));
    const view = render(<LinkPhonePanel />);
    const rows = () =>
      screen.getByTestId("link-phone-single-use-hint").parentElement
        ?.parentElement?.children.length;
    const withCode = {
      tile: screen.getByTestId("link-phone-qr-tile"),
      rows: rows(),
    };

    // The evicting restart drops the mint data, which is the moment the panel
    // used to collapse to a bare skeleton and resize the modal around it.
    mocks.useLinkLoginWatch.mockReturnValue({
      claim: null,
      deadKind: null,
      code: codeQuery({ data: null, isError: false, error: null }),
    });
    view.rerender(<LinkPhonePanel />);

    const pending = screen.getByTestId("link-phone-qr-tile");
    expect(pending.className).toBe(withCode.tile.className);
    expect(pending.getAttribute("data-tile-state")).toBe("loading");
    // Same rows around the tile: instructions, the code's box, the status
    // pair. Only their contents go quiet.
    expect(rows()).toBe(withCode.rows);
    expect(screen.getByTestId("link-phone-code-pending").textContent).toBe(
      "Getting a new code…",
    );
    expect(screen.getByTestId("link-phone-single-use-hint")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-countdown")).toBeNull();

    // And back again when the new code lands.
    mocks.useLinkLoginWatch.mockReturnValue(showing(Date.now(), "BBBBB-BBBBB"));
    view.rerender(<LinkPhonePanel />);
    expect(
      screen.getByTestId("link-phone-qr-tile").getAttribute("data-tile-state"),
    ).toBe("code");
    expect(rows()).toBe(withCode.rows);
  });

  it("shows the code with its scan instructions and single-use terms", () => {
    mocks.useLinkLoginWatch.mockReturnValue(showing(Date.now(), "ABCDE-FGHJK"));
    render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-qr")).toBeTruthy();
    expect(screen.getByTestId("link-phone-single-use-hint").textContent).toBe(
      "Each code signs in one phone, expires in about a minute, and only takes effect once you approve it here.",
    );
  });

  it("names the claimant's device and marks its details approximate", () => {
    mocks.useLinkLoginWatch.mockReturnValue({
      claim: {
        code: "ABCDE-FGHJK",
        address: "192.168.29.87",
        userAgent: "TraycerMobile/1.0 (iPhone)",
        location: "Bengaluru, IN",
      },
      deadKind: null,
      code: codeQuery({ data: null, isError: false, error: null }),
    });
    render(<LinkPhonePanel />);
    const confirm = screen.getByTestId("link-phone-confirm");
    expect(confirm.textContent).toContain("Approve sign-in from an iPhone?");
    expect(screen.getByTestId("link-phone-claimant").textContent).toBe(
      "192.168.29.87 · Bengaluru, IN · just now",
    );
    expect(confirm.textContent).toContain("These details are approximate");
    // No tile behind the decision — the code being decided is not on offer.
    expect(screen.queryByTestId("link-phone-qr")).toBeNull();
  });

  it("spins only the button that was pressed", () => {
    const claim = {
      code: "ABCDE-FGHJK",
      address: "192.168.29.87",
      userAgent: "TraycerMobile/1.0 (iPhone)",
      location: "Bengaluru, IN",
    };
    mocks.useLinkLoginWatch.mockReturnValue({
      claim,
      deadKind: null,
      code: codeQuery({ data: null, isError: false, error: null }),
    });
    // A reject round-trip in flight: Reject carries the spinner, Approve is
    // only disabled. Putting the spinner on Approve would read as though the
    // sign-in were being granted.
    mocks.useRespondLinkLoginMutation.mockReturnValue({
      isPending: true,
      variables: { code: "ABCDE-FGHJK", approve: false },
      mutate: vi.fn(),
    });
    const view = render(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-reject-spinner")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-approve-spinner")).toBeNull();
    expect(
      screen.getByTestId("link-phone-approve").hasAttribute("disabled"),
    ).toBe(true);
    // Labels never swap while pending.
    expect(screen.getByTestId("link-phone-reject").textContent).toContain(
      "Reject",
    );

    mocks.useRespondLinkLoginMutation.mockReturnValue({
      isPending: true,
      variables: { code: "ABCDE-FGHJK", approve: true },
      mutate: vi.fn(),
    });
    view.rerender(<LinkPhonePanel />);
    expect(screen.getByTestId("link-phone-approve-spinner")).toBeTruthy();
    expect(screen.queryByTestId("link-phone-reject-spinner")).toBeNull();
  });

  it("distinguishes a superseded code from one that was rejected elsewhere", () => {
    mocks.useLinkLoginWatch.mockReturnValue({
      claim: null,
      deadKind: "superseded",
      code: codeQuery({ data: null, isError: false, error: null }),
    });
    const view = render(<LinkPhonePanel />);
    const superseded = screen.getByTestId("link-phone-superseded");
    expect(superseded.textContent).toContain("This code is no longer active.");
    expect(superseded.textContent).toContain(
      "It expired, or another device or browser replaced it.",
    );
    expect(screen.queryByTestId("link-phone-qr")).toBeNull();
    // Restarting is the user's move, and the only one offered.
    expect(screen.getByTestId("link-phone-show-new")).toBeTruthy();

    mocks.useLinkLoginWatch.mockReturnValue({
      claim: null,
      deadKind: "rejected",
      code: codeQuery({ data: null, isError: false, error: null }),
    });
    view.rerender(<LinkPhonePanel />);
    const rejected = screen.getByTestId("link-phone-rejected-elsewhere");
    expect(rejected.textContent).toContain(
      "This sign-in request was rejected.",
    );
    expect(rejected.textContent).toContain("No phone was signed in.");
    expect(screen.queryByTestId("link-phone-superseded")).toBeNull();
  });

  it("points at the other surface when the claim awaits a decision there", () => {
    mocks.useLinkLoginWatch.mockReturnValue({
      claim: null,
      deadKind: null,
      code: codeQuery({
        data: null,
        isError: true,
        error: new LinkLoginMintError("claim-pending"),
      }),
    });
    render(<LinkPhonePanel />);
    const awaiting = screen.getByTestId("link-phone-awaiting-elsewhere");
    expect(awaiting.textContent).toContain(
      "A phone is waiting for your approval on another device or browser.",
    );
    expect(awaiting.textContent).toContain(
      "Approve or reject it there, then a new code can be shown here.",
    );
    expect(screen.queryByTestId("link-phone-qr")).toBeNull();
  });

  it("closes on the approved state without offering a live code", () => {
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
    mocks.useLinkLoginWatch.mockReturnValue({
      claim: {
        code: "ABCDE-FGHJK",
        address: null,
        userAgent: null,
        location: null,
      },
      deadKind: null,
      code: codeQuery({ data: null, isError: false, error: null }),
    });
    render(<LinkPhonePanel />);
    // Metadata the server never observed is left out rather than confessed —
    // "just now" is the one part always true, and it anchors the line alone.
    expect(screen.getByTestId("link-phone-claimant").textContent).toBe(
      "just now",
    );
    // An unknown User-Agent still names something, never a blank.
    expect(screen.getByTestId("link-phone-confirm").textContent).toContain(
      "Approve sign-in from a device?",
    );
    act(() => {
      screen.getByTestId("link-phone-approve").click();
    });
    expect(screen.getByTestId("link-phone-approved").textContent).toContain(
      "Approved. The phone is signing in now.",
    );
    expect(screen.queryByTestId("link-phone-qr")).toBeNull();
    expect(screen.getByTestId("link-phone-restart")).toBeTruthy();
  });
});
