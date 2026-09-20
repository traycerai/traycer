import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  isCustomizeAvailable,
  isLegacyLayoutAvailable,
} from "@/lib/settings/settings-availability";
import { useSettingsStore } from "@/stores/settings/settings-store";

const DESKTOP_WIDTH = 1280;
const NARROW_WIDTH = 400;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

/**
 * Renders the hook and reports the two predicates it feeds, which is what a
 * panel and the search index actually ask - `customizeEditor` itself is only
 * ever read through them.
 */
function readAvailability(): {
  customizeEditor: boolean;
  customize: boolean;
  legacyLayout: boolean;
} {
  // A list rather than a `let … | null`: assigning inside the probe is
  // invisible to control-flow narrowing, so the null check afterwards reads as
  // a comparison against a literal `null` type.
  const seen: {
    customizeEditor: boolean;
    customize: boolean;
    legacyLayout: boolean;
  }[] = [];

  function Probe(): null {
    const context = useSettingsAvailabilityContext();
    seen.push({
      customizeEditor: context.customizeEditor,
      customize: isCustomizeAvailable(context),
      legacyLayout: isLegacyLayoutAvailable(context),
    });
    return null;
  }

  render(<Probe />);
  const value = seen.at(-1);
  if (value === undefined) throw new Error("the probe did not render");
  return value;
}

describe("useSettingsAvailabilityContext customizeEditor", () => {
  afterEach(() => {
    cleanup();
    setViewportWidth(DESKTOP_WIDTH);
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  });

  it("is off on a desktop window while the switch is off", () => {
    setViewportWidth(DESKTOP_WIDTH);
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });

    expect(readAvailability()).toEqual({
      customizeEditor: false,
      customize: false,
      legacyLayout: true,
    });
  });

  it("is on with the switch on and a desktop window", () => {
    setViewportWidth(DESKTOP_WIDTH);
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    expect(readAvailability()).toEqual({
      customizeEditor: true,
      customize: true,
      legacyLayout: false,
    });
  });

  it("stays off on a narrow window even with the switch on", () => {
    // D22: a narrow window keeps the full Layout page whatever the switch
    // says, so the switch alone is never the answer.
    setViewportWidth(NARROW_WIDTH);
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    expect(readAvailability()).toEqual({
      customizeEditor: false,
      customize: false,
      legacyLayout: true,
    });
  });

  it("is off on a narrow window with the switch off", () => {
    setViewportWidth(NARROW_WIDTH);
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });

    expect(readAvailability()).toEqual({
      customizeEditor: false,
      customize: false,
      legacyLayout: true,
    });
  });
});
