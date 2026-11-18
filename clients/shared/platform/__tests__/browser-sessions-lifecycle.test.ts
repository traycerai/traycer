import { describe, expect, it } from "vitest";
import type { StreamCloseReason } from "../../host-transport/i-stream-session";
import {
  BROWSERS_APP_OUTDATED_MESSAGE,
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

const incompatibleClientBehind: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "INCOMPATIBLE",
    reason: "Incompatible methods: browser.sessions",
    incompatibleMethods: null,
    upgradeGuidance: { clientShouldUpgrade: true, hostShouldUpgrade: false },
  },
};

const incompatibleNoGuidance: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "INCOMPATIBLE",
    reason: "Incompatible methods: browser.sessions",
    incompatibleMethods: null,
    upgradeGuidance: null,
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
    // No guidance at all (an older host's fatal) reads the same way: the
    // host is the side that predates the method.
    expect(browserSessionsError("closed", incompatibleNoGuidance)).toBe(
      BROWSERS_UNSUPPORTED_MESSAGE,
    );
  });

  it("names the app as the side to update when the host is the newer one", () => {
    expect(browserSessionsLifecycle("closed", incompatibleClientBehind)).toBe(
      "unsupported",
    );
    expect(browserSessionsError("closed", incompatibleClientBehind)).toBe(
      BROWSERS_APP_OUTDATED_MESSAGE,
    );
  });

  it("keeps every other fatal as a failure with its own reason", () => {
    expect(browserSessionsLifecycle("closed", otherFatal)).toBe("failed");
    expect(browserSessionsError("closed", otherFatal)).toBe("Bearer rejected.");
  });

  it("refuses an open with the stream's own message only when unsupported", () => {
    expect(
      browserSessionsRefusal({
        lifecycle: "unsupported",
        errorMessage: BROWSERS_APP_OUTDATED_MESSAGE,
      }),
    ).toBe(BROWSERS_APP_OUTDATED_MESSAGE);
    expect(
      browserSessionsRefusal({ lifecycle: "unsupported", errorMessage: null }),
    ).toBe(BROWSERS_UNSUPPORTED_MESSAGE);
    expect(
      browserSessionsRefusal({
        lifecycle: "connecting",
        errorMessage: null,
      }),
    ).toBe("Browsers are not connected yet.");
    expect(browserSessionsRefusal(null)).toBe(
      "Browsers are not connected yet.",
    );
  });
});
