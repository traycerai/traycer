import { afterEach, describe, expect, it } from "vitest";
import {
  __resetThanosFlagsForTesting,
  __setThanosSingleUserChromeForTests,
  isThanosHiddenSettingsSection,
  isThanosSingleUserChrome,
} from "../thanos-flags";

describe("thanos-flags", () => {
  afterEach(() => {
    __resetThanosFlagsForTesting();
  });

  it("keeps account chrome visible in unit tests by default", () => {
    expect(isThanosSingleUserChrome()).toBe(false);
    expect(isThanosHiddenSettingsSection("devices")).toBe(false);
    expect(isThanosHiddenSettingsSection("usage")).toBe(false);
    expect(isThanosHiddenSettingsSection("general")).toBe(false);
  });

  it("hides devices and usage when the single-user override is on", () => {
    __setThanosSingleUserChromeForTests(true);
    expect(isThanosSingleUserChrome()).toBe(true);
    expect(isThanosHiddenSettingsSection("devices")).toBe(true);
    expect(isThanosHiddenSettingsSection("usage")).toBe(true);
    expect(isThanosHiddenSettingsSection("general")).toBe(false);
  });
});
