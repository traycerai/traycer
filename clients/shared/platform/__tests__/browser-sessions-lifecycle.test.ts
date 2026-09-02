import { describe, expect, it } from "vitest";
import type { StreamCloseReason } from "../../host-transport/i-stream-session";
import {
  BROWSERS_UNSUPPORTED_MESSAGE,
  browserSessionsError,
  browserSessionsLifecycle,
  browserSessionsRefusal,
} from "../browser-view";

const incompatible: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "INCOMPATIBLE",
    reason: "Incompatible methods: browser.sessions",
    incompatibleMethods: null,
    upgradeGuidance: { clientShouldUpgrade: false, hostShouldUpgrade: true },
  },
};

const otherFatal: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "UNAUTHORIZED",
    reason: "Bearer rejected.",
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
};

describe("browser sessions lifecycle on a host without browsers", () => {
  it("reads an INCOMPATIBLE close as unsupported, with the remedy as its message", () => {
    // A host from before `browser.sessions` existed refuses the subscribe at
    // handshake. That is a fact about the host, not about this attempt, so it
    // must not read as a retryable failure carrying the raw protocol reason.
    expect(browserSessionsLifecycle("closed", incompatible)).toBe(
      "unsupported",
    );
    expect(browserSessionsError("closed", incompatible)).toBe(
      BROWSERS_UNSUPPORTED_MESSAGE,
    );
  });

  it("keeps every other fatal as a failure with its own reason", () => {
    expect(browserSessionsLifecycle("closed", otherFatal)).toBe("failed");
    expect(browserSessionsError("closed", otherFatal)).toBe("Bearer rejected.");
  });

  it("refuses an open with the remedy only when the host is unsupported", () => {
    expect(browserSessionsRefusal("unsupported")).toBe(
      BROWSERS_UNSUPPORTED_MESSAGE,
    );
    expect(browserSessionsRefusal("connecting")).toBe(
      "Browsers are not connected yet.",
    );
    expect(browserSessionsRefusal(null)).toBe(
      "Browsers are not connected yet.",
    );
  });
});
