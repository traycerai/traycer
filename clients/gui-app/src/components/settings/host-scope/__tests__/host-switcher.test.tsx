import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";

/**
 * The switcher's empty state is the second consumer of the rule the gate
 * already enforces: a FAILED host list is not an empty account. These cases
 * exist because the rule was fixed at the gate and this consumer was missed —
 * the sidebar confidently said "No hosts yet" beside a panel saying the lists
 * failed, and its Add-host opener recorded an empty known-hosts snapshot that
 * a later successful retry turned into a false "your host just connected".
 */

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

afterEach(cleanup);

function renderEmpty(props: {
  readonly isLoading: boolean;
  readonly listsFailed: boolean;
  readonly onAddHost?: () => void;
  readonly onRetryLists?: () => void;
}): void {
  render(
    <HostSwitcher
      hosts={[]}
      selected={null}
      activeHostId={null}
      onSelect={() => undefined}
      onAddHost={props.onAddHost ?? (() => undefined)}
      isLoading={props.isLoading}
      listsFailed={props.listsFailed}
      onRetryLists={props.onRetryLists ?? (() => undefined)}
    />,
  );
}

describe("<HostSwitcher /> empty vs failed", () => {
  it("reports a failed load with a retry instead of claiming an empty account", () => {
    const onRetryLists = vi.fn();
    const onAddHost = vi.fn();
    renderEmpty({
      isLoading: false,
      listsFailed: true,
      onRetryLists,
      onAddHost,
    });

    expect(
      screen.getByTestId("settings-host-switcher-lists-failed"),
    ).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-empty")).toBeNull();
    // Add host is withheld here on purpose: opening it now would snapshot an
    // empty known-hosts list, and the arrival watcher would later announce a
    // pre-existing host as the new machine.
    expect(screen.queryByTestId("settings-host-switcher-empty-add")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLists).toHaveBeenCalledTimes(1);
  });

  it("still claims an empty account when the lists genuinely answered", () => {
    renderEmpty({ isLoading: false, listsFailed: false });

    expect(screen.getByTestId("settings-host-switcher-empty")).not.toBeNull();
    expect(
      screen.getByTestId("settings-host-switcher-empty-add"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-lists-failed"),
    ).toBeNull();
  });

  it("keeps reporting loading while a failed list is being retried", () => {
    // `isLoading` wins: mid-retry the honest claim is "finding", not a stale
    // failure notice that flickers away when the refetch lands.
    renderEmpty({ isLoading: true, listsFailed: true });

    expect(screen.getByTestId("settings-host-switcher-empty")).not.toBeNull();
    expect(screen.getByText("Finding your hosts…")).not.toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-lists-failed"),
    ).toBeNull();
  });

  it("never shows the failure state while hosts are in hand", () => {
    // A background refetch failure must not blank a working picker.
    render(
      <HostSwitcher
        hosts={[hostScopeOptionFixture({ hostId: "host-a", name: "Host A" })]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        onAddHost={() => undefined}
        isLoading={false}
        listsFailed
        onRetryLists={() => undefined}
      />,
    );

    expect(
      screen.queryByTestId("settings-host-switcher-lists-failed"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    ).not.toBeNull();
  });

  it("surfaces a partial failure inside the popover while hosts are in hand", () => {
    // One source list failed while the other still contributed rows: the
    // union is nonempty, so the empty branch never runs — but presenting
    // half an account as all of it is the same false claim. The rows stay
    // usable; the footer names the gap and offers the retry.
    const onRetryLists = vi.fn();
    render(
      <HostSwitcher
        hosts={[hostScopeOptionFixture({ hostId: "host-a", name: "Host A" })]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        onAddHost={() => undefined}
        isLoading={false}
        listsFailed
        onRetryLists={onRetryLists}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );
    expect(
      screen.getByTestId("settings-host-switcher-partial-failure"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLists).toHaveBeenCalledTimes(1);
  });

  it("labels a plan-gated host 'requires upgrade', not 'unreachable'", () => {
    // Same `connectable: false`, different fact: one is fixed by an upgrade,
    // the other maybe by waiting. One word covering both sent people
    // debugging their network over a billing limit.
    render(
      <HostSwitcher
        hosts={[
          hostScopeOptionFixture({
            hostId: "host-gated",
            name: "Office Linux",
            isLocalMachine: false,
            connectable: false,
            planRestricted: true,
          }),
        ]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        onAddHost={() => undefined}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );
    expect(screen.getByText("requires upgrade")).not.toBeNull();
    expect(screen.queryByText("unreachable")).toBeNull();
  });
});
