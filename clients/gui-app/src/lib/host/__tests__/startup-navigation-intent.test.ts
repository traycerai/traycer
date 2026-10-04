/**
 * Pins the two boot escape-hatch sources onto one shared history state
 * builder: the boot card stamps only the startup-navigation marker, the desktop
 * menu additionally stamps the menu-settings marker, and both preserve every
 * foreign key on the previous state. Expected objects use literal key strings
 * so the pins do not merely echo the exported constants.
 */
import type { HistoryState } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import {
  isStartupMenuSettingsIntent,
  isStartupNavigationIntent,
  withStartupNavigationIntent,
} from "@/lib/host/startup-navigation-intent";

/**
 * Mirror of `@tanstack/history` ParsedHistoryState. Not re-exported from
 * `@tanstack/react-router`; see `navigation-envelope.test.ts`.
 */
type ParsedHistoryState = HistoryState & {
  readonly key: string | undefined;
  readonly __TSR_key: string | undefined;
  readonly __TSR_index: number;
  readonly keep: string;
};

function previousState(): ParsedHistoryState {
  return {
    __TSR_index: 3,
    key: "k1",
    __TSR_key: "k1",
    keep: "x",
  };
}

describe("withStartupNavigationIntent", () => {
  it("boot-card: stamps exactly the startup-navigation-intent marker", () => {
    const next = withStartupNavigationIntent(previousState(), "boot-card");

    expect(next).toStrictEqual({
      __TSR_index: 3,
      key: "k1",
      __TSR_key: "k1",
      keep: "x",
      __traycerStartupNavigationIntent: true,
    });
  });

  it("desktop-menu: stamps both the startup-navigation-intent and the menu-settings markers", () => {
    const next = withStartupNavigationIntent(previousState(), "desktop-menu");

    expect(next).toStrictEqual({
      __TSR_index: 3,
      key: "k1",
      __TSR_key: "k1",
      keep: "x",
      __traycerStartupNavigationIntent: true,
      __traycerStartupMenuSettingsIntent: true,
    });
  });

  it("isStartupNavigationIntent is true for both sources", () => {
    expect(
      isStartupNavigationIntent(
        withStartupNavigationIntent(previousState(), "boot-card"),
      ),
    ).toBe(true);
    expect(
      isStartupNavigationIntent(
        withStartupNavigationIntent(previousState(), "desktop-menu"),
      ),
    ).toBe(true);
  });

  it("isStartupMenuSettingsIntent distinguishes the two sources", () => {
    expect(
      isStartupMenuSettingsIntent(
        withStartupNavigationIntent(previousState(), "boot-card"),
      ),
    ).toBe(false);
    expect(
      isStartupMenuSettingsIntent(
        withStartupNavigationIntent(previousState(), "desktop-menu"),
      ),
    ).toBe(true);
  });
});
