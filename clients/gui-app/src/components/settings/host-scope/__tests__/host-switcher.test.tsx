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
      action={{
        kind: "add-host",
        onSelect: props.onAddHost ?? (() => undefined),
      }}
      surface="rail"
      intent="view"
      disabled={false}
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
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        disabled={false}
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
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        disabled={false}
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
        action={{ kind: "add-host", onSelect: () => undefined }}
        surface="rail"
        intent="view"
        disabled={false}
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

describe("<HostSwitcher /> trailing action", () => {
  // The two surfaces mounting this picker end the list differently on
  // purpose: Settings owns the add-host dialog — the snapshot it takes and
  // every failure state it can land in all live there — so its footer opens
  // that flow directly. The header's usage popover only WATCHES a host; it
  // has no business growing a second copy of that dialog, so its footer
  // instead points back to Settings. The host rows above are identical
  // either way — only this trailing row changes with `action.kind`.
  it("ends the list with Manage hosts…, not Add host…, for the manage-hosts kind", () => {
    const onSelect = vi.fn();
    render(
      <HostSwitcher
        hosts={[hostScopeOptionFixture({ hostId: "host-a", name: "Host A" })]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect }}
        surface="panel-header"
        intent="view"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Settings host: none selected" }),
    );

    expect(screen.getByTestId("settings-host-switcher-manage")).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-add")).toBeNull();
    expect(screen.queryByText("Add host…")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-host-switcher-manage"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("offers Manage hosts…, not Add host…, in the genuinely-empty branch", () => {
    // Same rule at the empty branch's opener: a picker that ends in
    // manage-hosts must not fall back to add-host just because `hosts` is
    // empty — the empty state is still Settings-vs-popover, not a special
    // third ending.
    render(
      <HostSwitcher
        hosts={[]}
        selected={null}
        activeHostId={null}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect: () => undefined }}
        surface="panel-header"
        intent="view"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
      />,
    );

    expect(
      screen.getByTestId("settings-host-switcher-empty-manage"),
    ).not.toBeNull();
    expect(screen.getByText("Manage hosts…")).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-empty-add")).toBeNull();
  });
});
