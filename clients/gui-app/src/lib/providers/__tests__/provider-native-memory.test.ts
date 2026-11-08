import { describe, expect, it } from "vitest";
import { providersListReportsNativeMemory } from "@/lib/providers/provider-native-memory";

// The component test drives `providers.list` at 10.8 (reports) and 10.7
// (does not) through the real negotiated-manifest registry. This file holds
// only the boundaries that test does not reach directly: no handshake yet,
// a later minor on the same major, and a different major entirely - which
// the pinned-major comment above the function calls out as deliberately NOT
// treated as "newer, so still reports".
describe("providersListReportsNativeMemory", () => {
  it("does not report with no negotiated version", () => {
    expect(providersListReportsNativeMemory(null)).toBe(false);
  });

  it("reports on a later minor of the same major", () => {
    expect(providersListReportsNativeMemory({ major: 10, minor: 9 })).toBe(
      true,
    );
  });

  it("does not report on a later major, even with a high minor", () => {
    expect(providersListReportsNativeMemory({ major: 11, minor: 0 })).toBe(
      false,
    );
  });
});
