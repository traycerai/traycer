import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HostScopeGate } from "@/components/settings/host-scope/host-scope-gate";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";

/**
 * The gate is where "no hosts in hand" is turned into a sentence a person
 * reads, and the two ways of having none are not the same claim:
 *
 *   - the lists answered, and the account owns nothing → install one.
 *   - a list request FAILED → we do not know, and retrying is the fix.
 *
 * Collapsing them told people with hosts to go install a host.
 */
describe("<HostScopeGate /> empty and failed states", () => {
  afterEach(cleanup);

  it("offers no return action when the unreachable host is already the active one", async () => {
    // Asking `connectable` before `isFollowing` made `unreachable` reachable
    // for the ACTIVE host, which turned this action into a no-op: "Back to X"
    // while already on X, calling `returnToActive` to clear an override that
    // is already null. Nothing changes, including the notice the user is
    // looking at. An action that cannot alter the state it is offered against
    // is worse than none — it reads as the way out.
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      name: "This Mac",
      isActive: true,
      connectable: false,
    });
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: active,
          hostId: active.hostId,
          status: "unreachable",
          activeHostId: active.hostId,
          activeHost: active,
          isViewingActive: true,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    // The explanation still renders — only the dead button is withheld.
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-return-to-active")).toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("still offers the way back when the unreachable host is not the active one", async () => {
    // The counterweight: withholding the action for the active host must not
    // withhold it for a pick that genuinely has somewhere to return to.
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-picked",
            name: "Studio Linux",
            connectable: false,
          }),
          hostId: "host-picked",
          status: "unreachable",
          activeHostId: "host-active",
          activeHost: hostScopeOptionFixture({
            hostId: "host-active",
            name: "This Mac",
            isActive: true,
          }),
          isViewingActive: false,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("host-scope-return-to-active")).not.toBeNull();
  });

  it("says the list failed, and offers a retry, rather than claiming an empty account", () => {
    const retryLists = vi.fn();
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: null,
          listsFailed: true,
          isLoading: false,
          retryLists,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("host-scope-lists-failed")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-empty")).toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();

    screen.getByTestId("host-scope-retry-lists").click();
    expect(retryLists).toHaveBeenCalledTimes(1);
  });

  it("still claims an empty account when the lists genuinely answered", () => {
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: null,
          listsFailed: false,
          isLoading: false,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("host-scope-empty")).not.toBeNull();
    expect(screen.getByText("No hosts yet")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-lists-failed")).toBeNull();
  });

  it("reports a vanished pick ahead of a failed list", () => {
    // Precedence: a failing background list must not overwrite the more
    // specific verdict the user needs, which names the host they picked.
    render(
      <HostScopeGate
        scope={hostScopeFixture({
          host: null,
          status: "vanished",
          vanishedHostId: "host-gone",
          hostLabel: "host-gone",
          listsFailed: true,
        })}
        skeleton={<div data-testid="skeleton" />}
      >
        <div data-testid="body" />
      </HostScopeGate>,
    );

    expect(screen.getByTestId("host-scope-vanished")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-lists-failed")).toBeNull();
  });
});
