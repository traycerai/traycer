import { describe, expect, it } from "vitest";
import {
  onboardingHostIsSandbox,
  onboardingHostIsUsable,
  onboardingHostReadiness,
  type OnboardingHostPicker,
} from "@/components/onboarding/onboarding-host-picker-model";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const PERSONAL = hostScopeOptionFixture({ hostId: "laptop", name: "Laptop" });
const SANDBOX = hostScopeOptionFixture({
  hostId: "sbx-1",
  name: "Build box",
  kind: "sandbox",
  connectable: true,
  sandbox: {
    state: "awake",
    frozen: false,
    summary: sandboxSummaryFixture({ hostId: "sbx-1", burst: false }),
  },
});
/** A sandbox whose control-plane row has not answered: still a sandbox. */
const SANDBOX_UNANSWERED = hostScopeOptionFixture({
  hostId: "sbx-2",
  name: "Unlisted box",
  kind: "sandbox",
  sandbox: { state: "awake", frozen: false, summary: null },
});

function picker(input: {
  readonly host: typeof PERSONAL | null;
  readonly hasExplicitPick: boolean;
  readonly streamOnPickedHost: boolean;
}): OnboardingHostPicker {
  return {
    scope: hostScopeFixture({
      host: input.host,
      hosts: input.host === null ? [] : [input.host],
    }),
    onSelectHost: () => undefined,
    hasExplicitPick: input.hasExplicitPick,
    streamOnPickedHost: input.streamOnPickedHost,
  };
}

describe("onboardingHostIsSandbox", () => {
  it("is true when the scope's host carries sandbox facts, answered or not", () => {
    for (const host of [SANDBOX, SANDBOX_UNANSWERED]) {
      expect(
        onboardingHostIsSandbox(
          picker({ host, hasExplicitPick: false, streamOnPickedHost: true }),
        ),
      ).toBe(true);
    }
  });

  it("is false for a personal host and for no host at all", () => {
    expect(
      onboardingHostIsSandbox(
        picker({
          host: PERSONAL,
          hasExplicitPick: true,
          streamOnPickedHost: true,
        }),
      ),
    ).toBe(false);
    expect(
      onboardingHostIsSandbox(
        picker({
          host: null,
          hasExplicitPick: false,
          streamOnPickedHost: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("onboardingHostReadiness on a sandbox scope", () => {
  it("is unavailable even when the user made no pick, where the shared rule would say ready", () => {
    expect(
      onboardingHostReadiness(
        picker({
          host: SANDBOX,
          hasExplicitPick: false,
          streamOnPickedHost: true,
        }),
      ),
    ).toBe("unavailable");
  });

  it("is unavailable whatever the pick and the stream say", () => {
    for (const hasExplicitPick of [true, false]) {
      for (const streamOnPickedHost of [true, false]) {
        expect(
          onboardingHostReadiness(
            picker({ host: SANDBOX, hasExplicitPick, streamOnPickedHost }),
          ),
        ).toBe("unavailable");
      }
    }
  });

  it("holds the stages: not usable", () => {
    expect(
      onboardingHostIsUsable(
        picker({
          host: SANDBOX,
          hasExplicitPick: false,
          streamOnPickedHost: true,
        }),
      ),
    ).toBe(false);
  });

  it("control: a personal host with no pick is still ready, and usable", () => {
    const personal = picker({
      host: PERSONAL,
      hasExplicitPick: false,
      streamOnPickedHost: true,
    });
    expect(onboardingHostReadiness(personal)).toBe("ready");
    expect(onboardingHostIsUsable(personal)).toBe(true);
  });
});
