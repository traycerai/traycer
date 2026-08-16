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
});
