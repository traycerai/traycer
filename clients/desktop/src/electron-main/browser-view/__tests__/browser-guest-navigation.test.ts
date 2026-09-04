import { describe, expect, it } from "vitest";
import {
  isAllowedGuestNavigationUrl,
  isAllowedHostInitiatedNavigationUrl,
} from "../browser-guest-navigation";

describe("isAllowedGuestNavigationUrl", () => {
  it.each(["about:blank", "http://example.test/", "https://example.test/"])(
    "allows %s",
    (url) => {
      expect(isAllowedGuestNavigationUrl(url)).toBe(true);
    },
  );

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "traycer://internal/settings",
    "not a url",
  ])("refuses %s - a page must never pivot itself here", (url) => {
    expect(isAllowedGuestNavigationUrl(url)).toBe(false);
  });
});

describe("isAllowedHostInitiatedNavigationUrl", () => {
  it.each([
    "about:blank",
    "http://example.test/",
    "https://example.test/",
    "file:///tmp/modal.html",
  ])("allows %s", (url) => {
    expect(isAllowedHostInitiatedNavigationUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "traycer://internal/settings",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isAllowedHostInitiatedNavigationUrl(url)).toBe(false);
  });
});
