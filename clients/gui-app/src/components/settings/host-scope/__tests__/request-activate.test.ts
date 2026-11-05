import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActivateResult,
  SelectionAuthorityClient,
  SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { requestActivate } from "@/components/settings/host-scope/use-host-scope";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// The wake is the sandbox suite's concern; here only that it is asked for.
vi.mock("@/lib/sandboxes/sandbox-wake", () => ({
  wakeSandboxOnPick: vi.fn(),
}));

import { toast } from "sonner";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";

const NO_SUB: SelectionSubscription = { dispose: () => undefined };

function fakeAuthority(
  activate: (hostId: string) => Promise<ActivateResult>,
): SelectionAuthorityClient {
  return {
    attach: () => Promise.resolve({ ok: false, kind: "superseded" }),
    reportEvidence: () => Promise.resolve(),
    activate,
    onSelectionChanged: () => NO_SUB,
    onLeasesChanged: () => NO_SUB,
    onReattachRequired: () => NO_SUB,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("requestActivate (Settings ▸ Activate, the only preferred-host write path)", () => {
  it("ok:true tracks exactly one HostSelected, following the option's host_kind, and toasts nothing", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: true }),
    );
    const localOption = hostScopeOptionFixture({
      hostId: "local-1",
      isLocalMachine: true,
    });

    await expect(
      requestActivate(fakeAuthority(activate), "local-1", localOption),
    ).resolves.toBe(true);

    expect(activate).toHaveBeenCalledWith("local-1");
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostSelected, {
      source: "direct_ui",
      host_kind: "local",
    });
    expect(toast.error).not.toHaveBeenCalled();

    // ANTI-VACUITY ANCHOR for the refusal cases below: this spy DOES fire
    // for a real success, so a broken/uninstalled spy cannot make a refusal
    // test's "not called" assertion pass for free.
  });

  it("ok:true reports host_kind: remote for a non-local option", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: true }),
    );
    const remoteOption = hostScopeOptionFixture({
      hostId: "remote-1",
      isLocalMachine: false,
    });

    await expect(
      requestActivate(fakeAuthority(activate), "remote-1", remoteOption),
    ).resolves.toBe(true);

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostSelected, {
      source: "direct_ui",
      host_kind: "remote",
    });
  });

  it("ok:true wakes the option it activated, and a refusal wakes nothing", async () => {
    const option = hostScopeOptionFixture({
      hostId: "sbx-1",
      kind: "sandbox",
      sandbox: {
        state: "suspended",
        frozen: false,
        summary: null,
        teamOwned: false,
      },
    });

    await requestActivate(
      fakeAuthority((): Promise<ActivateResult> =>
        Promise.resolve({ ok: true }),
      ),
      "sbx-1",
      option,
    );
    expect(wakeSandboxOnPick).toHaveBeenCalledTimes(1);
    expect(wakeSandboxOnPick).toHaveBeenCalledWith(option, null);

    vi.mocked(wakeSandboxOnPick).mockClear();
    await requestActivate(
      fakeAuthority((): Promise<ActivateResult> =>
        Promise.resolve({ ok: false, reason: "unknown-host" }),
      ),
      "sbx-1",
      option,
    );
    await requestActivate(
      fakeAuthority(() => Promise.reject(new Error("transport exploded"))),
      "sbx-1",
      option,
    );
    expect(wakeSandboxOnPick).not.toHaveBeenCalled();
  });

  it("reason unknown-host: no analytics, explains that it is gone and the previous machine stays active", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "unknown-host" }),
    );
    const option = hostScopeOptionFixture({
      hostId: "gone-1",
      name: "Gone Machine",
    });

    await expect(
      requestActivate(fakeAuthority(activate), "gone-1", option),
    ).resolves.toBe(false);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "It's gone from your account. The previous machine stays active.",
    );
  });

  it("reason incompatible: no analytics, tells the person to update the app", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "incompatible" }),
    );
    const option = hostScopeOptionFixture({
      hostId: "old-1",
      name: "Old Machine",
    });

    await requestActivate(fakeAuthority(activate), "old-1", option);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Update the app to use this machine.",
    );
  });

  it("reason team-host: no analytics, explains why a team's machine cannot be the app default", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "team-host" }),
    );
    const option = hostScopeOptionFixture({
      hostId: "team-1",
      name: "Platform Pod",
    });

    await requestActivate(fakeAuthority(activate), "team-1", option);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "A team's machine can't be the app's default.",
    );
  });

  it("reason not-attached: no analytics, offers a retry", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "not-attached" }),
    );
    const option = hostScopeOptionFixture({
      hostId: "any-1",
      name: "Any Machine",
    });

    await requestActivate(fakeAuthority(activate), "any-1", option);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Try again in a moment.");
  });

  it("reason persist-failed: no analytics, explains that the previous machine stays active and offers a retry", async () => {
    // Nothing moved and no event fired, so the same Activate is safe to
    // retry verbatim - which is why the copy says "try again", not "it may
    // or may not have applied". And it must NOT name the host, same family
    // as `not-attached`: this is a failure of this window's own machinery
    // (the preference could not be made durable), not a fact about the host,
    // so naming it would misattribute the fault to a machine that is fine.
    // Asserting the literal string (not just "no host name substring")
    // catches a future edit that starts interpolating the label in here.
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "persist-failed" }),
    );
    const option = hostScopeOptionFixture({
      hostId: "any-1",
      name: "Any Machine",
    });

    await requestActivate(fakeAuthority(activate), "any-1", option);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "The choice didn't stick — the previous machine stays active. Try again.",
    );
  });

  it("reason unrecognized: no analytics, explains the outcome is unknown", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "unrecognized" }),
    );
    const option = hostScopeOptionFixture({
      hostId: "weird-1",
      name: "Weird Machine",
    });

    await requestActivate(fakeAuthority(activate), "weird-1", option);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't confirm Weird Machine as the app's machine. Check which machine is active, then try again.",
    );
  });

  it("a null option still produces sensible copy and remote analytics", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const okActivate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: true }),
    );
    await requestActivate(fakeAuthority(okActivate), "unknown-to-panel", null);
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostSelected, {
      source: "direct_ui",
      host_kind: "remote",
    });

    const refusingActivate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "unknown-host" }),
    );
    await requestActivate(
      fakeAuthority(refusingActivate),
      "unknown-to-panel",
      null,
    );
    expect(toast.error).toHaveBeenCalledWith(
      "It's gone from your account. The previous machine stays active.",
    );
  });

  it("a REJECTING activate call gives confirmation guidance without analytics or throwing", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.reject(new Error("transport exploded")),
    );
    const option = hostScopeOptionFixture({
      hostId: "boom-1",
      name: "Boom Machine",
    });

    await expect(
      requestActivate(fakeAuthority(activate), "boom-1", option),
    ).resolves.toBe(false);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't confirm Boom Machine as the app's machine. Check which machine is active, then try again.",
    );
  });

  it("a rejected activate call uses the fallback label when the option is unavailable", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.reject(new Error("transport exploded")),
    );

    await expect(
      requestActivate(fakeAuthority(activate), "unknown-to-panel", null),
    ).resolves.toBe(false);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "Couldn't confirm that machine as the app's machine. Check which machine is active, then try again.",
    );
  });
});
