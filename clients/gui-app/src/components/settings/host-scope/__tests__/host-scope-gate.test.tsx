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
