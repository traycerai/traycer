import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

afterEach(cleanup);

const UNKNOWN = hostScopeOptionFixture({
  hostId: "unknown-host",
  name: "Unknown host",
});
const OLD = hostScopeOptionFixture({
  hostId: "old-host",
  name: "Old host",
});
const ABSENT = hostScopeOptionFixture({
  hostId: "absent-host",
  name: "Absent host",
});

function renderSwitcher(refusalByHostId: ReadonlyMap<string, string>): void {
  render(
    <HostSwitcher
      refusalByHostId={refusalByHostId}
      inertExceptHostId={null}
      hosts={[UNKNOWN, OLD, ABSENT]}
      selected={UNKNOWN}
      activeHostId={UNKNOWN.hostId}
      onSelect={() => undefined}
      action={{ kind: "manage-hosts", onSelect: () => undefined }}
      surface="field"
      intent="bind"
      disabled={false}
      isLoading={false}
      listsFailed={false}
      onRetryLists={() => undefined}
      updateViewForHost={null}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Host: Unknown host" }));
}

describe("<HostSwitcher /> surface refusals for a fork target", () => {
  it("does not render needs-update for an unknown handshake and leaves that row selectable", () => {
    renderSwitcher(new Map());

    expect(screen.queryByText("needs update")).toBeNull();
    const unknownRow = screen.getByTestId(
      "settings-host-switcher-option-unknown-host",
    );
    // Native attributes, not jest-dom: this repo does not register those
    // matchers (see vitest setupFiles).
    expect(unknownRow.getAttribute("data-disabled")).not.toBe("true");
    expect(unknownRow.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("disables a 1.1 / negotiated-absent host and labels it needs update", () => {
    renderSwitcher(
      new Map([
        ["old-host", "needs update"],
        ["absent-host", "needs update"],
      ]),
    );

    const oldRow = screen.getByTestId("settings-host-switcher-option-old-host");
    const absentRow = screen.getByTestId(
      "settings-host-switcher-option-absent-host",
    );
    expect(oldRow.textContent).toContain("needs update");
    expect(absentRow.textContent).toContain("needs update");
    expect(oldRow.getAttribute("aria-disabled")).toBe("true");
    expect(absentRow.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByTestId("settings-host-switcher-option-unknown-host")
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  it("inertExceptHostId disables every other row with no word on them", () => {
    const tab = hostScopeOptionFixture({
      hostId: "tab-host",
      name: "Tab host",
    });
    const other = hostScopeOptionFixture({
      hostId: "other-host",
      name: "Other host",
    });
    render(
      <HostSwitcher
        refusalByHostId={new Map()}
        inertExceptHostId="tab-host"
        hosts={[tab, other]}
        selected={tab}
        activeHostId={tab.hostId}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect: () => undefined }}
        surface="field"
        intent="bind"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Host: Tab host" }));

    const otherRow = screen.getByTestId(
      "settings-host-switcher-option-other-host",
    );
    const tabRow = screen.getByTestId("settings-host-switcher-option-tab-host");
    expect(otherRow.getAttribute("aria-disabled")).toBe("true");
    expect(otherRow.textContent).not.toContain("needs update");
    expect(tabRow.getAttribute("aria-disabled")).not.toBe("true");
    expect(tabRow.textContent).not.toContain("needs update");
  });

  it("inert leads: a 1.1 word does not appear on a class-inert row", () => {
    const tab = hostScopeOptionFixture({
      hostId: "tab-host",
      name: "Tab host",
    });
    render(
      <HostSwitcher
        refusalByHostId={
          new Map([
            ["old-host", "needs update"],
            ["absent-host", "needs update"],
          ])
        }
        inertExceptHostId="tab-host"
        hosts={[tab, OLD, ABSENT]}
        selected={tab}
        activeHostId={tab.hostId}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect: () => undefined }}
        surface="field"
        intent="bind"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Host: Tab host" }));

    const oldRow = screen.getByTestId("settings-host-switcher-option-old-host");
    const absentRow = screen.getByTestId(
      "settings-host-switcher-option-absent-host",
    );
    expect(oldRow.getAttribute("aria-disabled")).toBe("true");
    expect(absentRow.getAttribute("aria-disabled")).toBe("true");
    expect(oldRow.textContent).not.toContain("needs update");
    expect(absentRow.textContent).not.toContain("needs update");
  });

  it("inert silences unreachable and requires-upgrade on a non-connectable row", () => {
    const tab = hostScopeOptionFixture({
      hostId: "tab-host",
      name: "Tab host",
    });
    const offline = hostScopeOptionFixture({
      hostId: "offline-host",
      name: "Offline host",
      connectable: false,
      planRestricted: false,
    });
    const gated = hostScopeOptionFixture({
      hostId: "gated-host",
      name: "Gated host",
      connectable: false,
      planRestricted: true,
    });
    render(
      <HostSwitcher
        refusalByHostId={new Map()}
        inertExceptHostId="tab-host"
        hosts={[tab, offline, gated]}
        selected={tab}
        activeHostId={tab.hostId}
        onSelect={() => undefined}
        action={{ kind: "manage-hosts", onSelect: () => undefined }}
        surface="field"
        intent="bind"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Host: Tab host" }));

    const offlineRow = screen.getByTestId(
      "settings-host-switcher-option-offline-host",
    );
    const gatedRow = screen.getByTestId(
      "settings-host-switcher-option-gated-host",
    );
    expect(offlineRow.getAttribute("aria-disabled")).toBe("true");
    expect(gatedRow.getAttribute("aria-disabled")).toBe("true");
    expect(offlineRow.textContent).not.toContain("unreachable");
    expect(gatedRow.textContent).not.toContain("requires upgrade");
  });
});
