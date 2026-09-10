import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HostVersionRows, type HostVersionRow } from "../host-version-rows";

afterEach(cleanup);

const baseRow: HostVersionRow = {
  version: "1.3.0-rc.3",
  releasedAt: "2026-08-01T00:00:00.000Z",
  yanked: false,
  isLatest: false,
  isInstalled: false,
  unavailableReason: null,
  unavailableDetail: null,
  newerData: false,
  storeFormatConfirmation: null,
};

function renderRows(
  rows: readonly HostVersionRow[],
  onInstallAnyway: (version: string) => void,
) {
  const onInstall = vi.fn();
  render(
    <TooltipProvider>
      <HostVersionRows
        rows={rows}
        totalCount={rows.length}
        showAll={false}
        onToggleShowAll={vi.fn()}
        installingVersion={null}
        disabled={false}
        onInstall={onInstall}
        onInstallAnyway={onInstallAnyway}
      />
    </TooltipProvider>,
  );
  return { onInstall, onInstallAnyway };
}

describe("HostVersionRows store-format actions", () => {
  it("keeps pending rows disabled but enables a blocked row through Install anyway", () => {
    const { onInstallAnyway } = renderRows(
      [
        {
          ...baseRow,
          version: "1.2.0",
          unavailableReason: "Checking chat stores…",
          unavailableDetail: null,
        },
        {
          ...baseRow,
          version: "1.3.0-rc.2",
          unavailableReason: "Reads chat store format 8; this device has 9",
          unavailableDetail:
            "Installing anyway may lose access to newer chats.",
          newerData: true,
          storeFormatConfirmation:
            "Nothing is deleted; a host that reads format 9 opens them again.",
        },
      ],
      vi.fn(),
    );

    expect(
      screen.getByRole("button", { name: "Install 1.2.0" }),
    ).toHaveProperty("disabled", true);
    screen.getByText("newer data");
    const override = screen.getByRole("button", {
      name: "Install 1.3.0-rc.2 anyway",
    });
    expect(override).toHaveProperty("disabled", false);
    fireEvent.click(override);
    expect(onInstallAnyway).toHaveBeenCalledWith("1.3.0-rc.2");
  });

  it("keeps a completed same-format row on the ordinary install path", () => {
    const { onInstall } = renderRows([baseRow], vi.fn());
    const install = screen.getByRole("button", { name: "Install 1.3.0-rc.3" });
    expect(install).toHaveProperty("disabled", false);
    fireEvent.click(install);
    expect(onInstall).toHaveBeenCalledWith("1.3.0-rc.3");
  });
});
