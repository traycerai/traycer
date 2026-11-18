import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `platform.ts` caches isMac()/isWindows() in a module-level constant computed
// at import time, so each scenario below needs a fresh module instance.
async function freshLeaderDigitBadge() {
  vi.resetModules();
  const [{ LeaderDigitBadge }, { leaderHint }] = await Promise.all([
    import("@/components/ui/leader-digit-badge"),
    import("@/components/ui/leader-digit-shortcuts"),
  ]);
  return { LeaderDigitBadge, leaderHint };
}

const ORIGINAL_USER_AGENT_DATA_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  window.navigator,
  "userAgentData",
);
const ORIGINAL_USER_AGENT_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  window.navigator,
  "userAgent",
);

function restoreNavigatorProperty(
  name: "userAgentData" | "userAgent",
  original: PropertyDescriptor | undefined,
): void {
  if (original !== undefined) {
    Object.defineProperty(window.navigator, name, original);
  } else {
    Reflect.deleteProperty(window.navigator, name);
  }
}

function setUserAgentData(platform: string | undefined): void {
  Object.defineProperty(window.navigator, "userAgentData", {
    value: platform === undefined ? undefined : { platform },
    configurable: true,
  });
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  restoreNavigatorProperty(
    "userAgentData",
    ORIGINAL_USER_AGENT_DATA_DESCRIPTOR,
  );
  restoreNavigatorProperty("userAgent", ORIGINAL_USER_AGENT_DESCRIPTOR);
});

describe("<LeaderDigitBadge /> rendered label and accessible name, per real platform", () => {
  it("renders ⌘1 / ⌥2 on macOS and threads the leaderHint aria-label through unchanged", async () => {
    setUserAgentData("macOS");
    const { LeaderDigitBadge, leaderHint } = await freshLeaderDigitBadge();

    render(
      <LeaderDigitBadge
        digit="1"
        modifier="mod"
        ariaLabel={leaderHint("1", "mod", "to switch to", "Runtime Core")}
        testId="badge-mod"
        className={undefined}
      />,
    );
    const modBadge = screen.getByTestId("badge-mod");
    expect(modBadge.textContent).toBe("⌘1");
    expect(modBadge.getAttribute("aria-label")).toBe(
      "Press Command+1 to switch to Runtime Core",
    );

    render(
      <LeaderDigitBadge
        digit="2"
        modifier="alt"
        ariaLabel={leaderHint("2", "alt", "to open", "Settings")}
        testId="badge-alt"
        className={undefined}
      />,
    );
    const altBadge = screen.getByTestId("badge-alt");
    expect(altBadge.textContent).toBe("⌥2");
    expect(altBadge.getAttribute("aria-label")).toBe(
      "Press Option+2 to open Settings",
    );
  });

  it("renders Ctrl+1 / Alt+2 on Windows (via userAgentData)", async () => {
    setUserAgentData("Windows");
    const { LeaderDigitBadge, leaderHint } = await freshLeaderDigitBadge();

    render(
      <LeaderDigitBadge
        digit="1"
        modifier="mod"
        ariaLabel={leaderHint("1", "mod", "to switch to", "Runtime Core")}
        testId="badge-mod"
        className={undefined}
      />,
    );
    const modBadge = screen.getByTestId("badge-mod");
    expect(modBadge.textContent).toBe("Ctrl+1");
    expect(modBadge.getAttribute("aria-label")).toBe(
      "Press Control+1 to switch to Runtime Core",
    );

    render(
      <LeaderDigitBadge
        digit="2"
        modifier="alt"
        ariaLabel={leaderHint("2", "alt", "to open", "Settings")}
        testId="badge-alt"
        className={undefined}
      />,
    );
    const altBadge = screen.getByTestId("badge-alt");
    expect(altBadge.textContent).toBe("Alt+2");
    expect(altBadge.getAttribute("aria-label")).toBe(
      "Press Alt+2 to open Settings",
    );
  });

  it("renders the same Ctrl+1 / Alt+2 labels on Linux (via userAgentData) - the badge has no Windows-specific branch", async () => {
    setUserAgentData("Linux");
    const { LeaderDigitBadge, leaderHint } = await freshLeaderDigitBadge();

    render(
      <LeaderDigitBadge
        digit="1"
        modifier="mod"
        ariaLabel={leaderHint("1", "mod", "to switch to", "Runtime Core")}
        testId="badge-mod"
        className={undefined}
      />,
    );
    const modBadge = screen.getByTestId("badge-mod");
    expect(modBadge.textContent).toBe("Ctrl+1");
    expect(modBadge.getAttribute("aria-label")).toBe(
      "Press Control+1 to switch to Runtime Core",
    );

    render(
      <LeaderDigitBadge
        digit="2"
        modifier="alt"
        ariaLabel={leaderHint("2", "alt", "to open", "Settings")}
        testId="badge-alt"
        className={undefined}
      />,
    );
    const altBadge = screen.getByTestId("badge-alt");
    expect(altBadge.textContent).toBe("Alt+2");
    expect(altBadge.getAttribute("aria-label")).toBe(
      "Press Alt+2 to open Settings",
    );
  });

  it("falls back to the UA string on macOS when userAgentData is absent (Safari/Firefox)", async () => {
    setUserAgentData(undefined);
    setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );
    const { LeaderDigitBadge, leaderHint } = await freshLeaderDigitBadge();

    render(
      <LeaderDigitBadge
        digit="1"
        modifier="mod"
        ariaLabel={leaderHint("1", "mod", "to switch to", "Runtime Core")}
        testId="badge"
        className={undefined}
      />,
    );
    expect(screen.getByTestId("badge").textContent).toBe("⌘1");
  });

  it("falls back to the UA string when userAgentData reports an empty client hint", async () => {
    setUserAgentData("");
    setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    const { LeaderDigitBadge, leaderHint } = await freshLeaderDigitBadge();

    render(
      <LeaderDigitBadge
        digit="1"
        modifier="mod"
        ariaLabel={leaderHint("1", "mod", "to switch to", "Runtime Core")}
        testId="badge"
        className={undefined}
      />,
    );
    expect(screen.getByTestId("badge").textContent).toBe("Ctrl+1");
  });
});
