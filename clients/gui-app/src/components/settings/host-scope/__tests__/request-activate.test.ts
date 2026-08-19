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

import { toast } from "sonner";

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

    await requestActivate(fakeAuthority(activate), "local-1", localOption);

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

    await requestActivate(fakeAuthority(activate), "remote-1", remoteOption);

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HostSelected, {
      source: "direct_ui",
      host_kind: "remote",
    });
  });

  it("reason unknown-host: no analytics, toasts that the host is no longer registered", async () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    const activate = vi.fn((): Promise<ActivateResult> =>
      Promise.resolve({ ok: false, reason: "unknown-host" }),
    );
    const option = hostScopeOptionFixture({
      hostId: "gone-1",
      name: "Gone Machine",
    });

    await requestActivate(fakeAuthority(activate), "gone-1", option);

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Gone Machine is no longer registered to this account.",
    );
  });

  it("reason incompatible: no analytics, toasts that the host needs an update", async () => {
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
      "Old Machine needs a host update before it can be activated.",
    );
  });

  it("reason not-attached: no analytics, toasts the reload-and-retry copy (option-independent)", async () => {
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
    expect(toast.error).toHaveBeenCalledWith(
      "This window lost its connection to the selection service - reload and try again.",
    );
  });

  it("reason persist-failed: no analytics, toasts the retry-safe copy WITHOUT naming the host (option-independent)", async () => {
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
      "Couldn't save your choice - try again.",
    );
  });

  it("reason unrecognized: no analytics, toasts the generic couldn't-activate copy naming the host", async () => {
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
      "Couldn't activate Weird Machine.",
    );
  });

  it("a null option still produces sensible copy ('That host' / 'remote')", async () => {
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
      "That host is no longer registered to this account.",
    );
  });

  it("a REJECTING activate call is caught: no analytics, generic toast, does not throw", async () => {
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
    ).resolves.toBeUndefined();

    expect(trackSpy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't activate this host. Try again.",
    );
  });
});
