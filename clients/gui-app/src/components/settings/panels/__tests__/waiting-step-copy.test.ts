import { describe, expect, it } from "vitest";
import type { ProviderLoginStartCopy } from "@/components/providers/provider-login-start";
import { waitingStepCopy } from "@/components/settings/panels/waiting-step-copy";

const STARTING_COPY: ProviderLoginStartCopy = {
  title: "Starting Claude Code…",
  guidance:
    "This can take up to a minute. The sign-in page opens as soon as it is ready.",
};

describe("waitingStepCopy", () => {
  it("uses the flow's startingCopy while queuePending and not cancelRequested", () => {
    expect(
      waitingStepCopy({
        phase: "idle",
        queuePending: true,
        startingCopy: STARTING_COPY,
        cancelRequested: false,
        deviceCode: false,
      }),
    ).toEqual(STARTING_COPY);
  });

  it("falls back to the ordinary 'Opening the sign-in page…' copy while queuePending with no startingCopy", () => {
    expect(
      waitingStepCopy({
        phase: "idle",
        queuePending: true,
        startingCopy: null,
        cancelRequested: false,
        deviceCode: false,
      }),
    ).toEqual({
      title: "Opening the sign-in page…",
      guidance: "This should only take a moment.",
    });
  });

  it("ignores startingCopy once cancelRequested, even while queuePending", () => {
    // `cancelRequested` is checked first: a start the user has asked to cancel
    // is no longer "starting" copy, whatever the flow was about to say.
    expect(
      waitingStepCopy({
        phase: "idle",
        queuePending: true,
        startingCopy: STARTING_COPY,
        cancelRequested: true,
        deviceCode: false,
      }),
    ).toEqual({
      title: "Cancelling sign-in",
      guidance:
        "Waiting for the sign-in attempt to start so it can be cancelled safely.",
    });
  });

  it("ignores startingCopy once queuePending is false, whatever it carries", () => {
    // A caller past the start (waiting on the browser leg) never reads
    // startingCopy - passing a non-null value here must not leak into the
    // phase-derived copy below.
    expect(
      waitingStepCopy({
        phase: "idle",
        queuePending: false,
        startingCopy: STARTING_COPY,
        cancelRequested: false,
        deviceCode: false,
      }),
    ).toEqual({
      title: "Approve sign-in in your browser",
      guidance:
        "We opened the sign-in page in your browser. We'll continue automatically after you approve.",
    });
  });

  it("still prefers the verifying/submitting phase copy over startingCopy when queuePending is false", () => {
    expect(
      waitingStepCopy({
        phase: "verifying",
        queuePending: false,
        startingCopy: STARTING_COPY,
        cancelRequested: false,
        deviceCode: false,
      }),
    ).toEqual({ title: "Checking approval…", guidance: null });
  });
});
