import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { hostSettingsCardState } from "@/components/settings/panels/host-overview-settings-card-model";
import { HostOverviewSettingsCard } from "@/components/settings/panels/host-overview-settings-card";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const ACCEPTED_AT = Date.UTC(2026, 9, 20, 12);

function renderCard(status: EnvironmentStatusResponseV11): void {
  const { client } = buildEnvironmentClient({ hostId: "old", handlers: {} });
  render(
    <HostOverviewSettingsCard
      client={client}
      hostId="old"
      hostName="Old laptop"
      status={status}
    />,
  );
}

const MOVE_LINES = [
  "host-settings-card-local",
  "host-settings-card-progress",
  "host-settings-card-moved",
];

function shownLines(): string[] {
  return MOVE_LINES.filter((id) => screen.queryByTestId(id) !== null);
}

beforeEach(() => {
  useMoveSheetStore.setState({ target: null });
});

afterEach(() => {
  cleanup();
});

describe("<HostOverviewSettingsCard />", () => {
  it("says the settings are on this computer only while awaiting, and Move to Personal opens the sheet", () => {
    renderCard(
      environmentStatusFixture({
        principal: null,
        setup: { stage: "moving_settings", state: "awaiting_consent" },
      }),
    );

    expect(shownLines()).toEqual(["host-settings-card-local"]);
    expect(screen.getByTestId("host-settings-card-local").textContent).toBe(
      "Settings on this computer only.",
    );
    fireEvent.click(screen.getByTestId("host-settings-card-move"));
    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
  });

  it("shows N of M items applied while moving", () => {
    renderCard(
      environmentStatusFixture({
        consent: { acceptedAt: ACCEPTED_AT, planHash: "h" },
        setup: { stage: "moving_settings", state: "running" },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "C", status: "pending" }),
        ],
        pendingUploads: [pendingUploadFixture({ kind: "variable", key: "D" })],
      }),
    );

    expect(shownLines()).toEqual(["host-settings-card-progress"]);
    expect(
      screen
        .getByTestId("host-settings-card-progress")
        .textContent.replace(/\s+/g, " "),
    ).toBe(
      "Moving this computer's settings to Personal · 2 of 4 items applied",
    );
    expect(screen.queryByTestId("host-settings-card-move")).toBeNull();
  });

  it("says when it moved, from the consent, once setup is past the move", () => {
    renderCard(
      environmentStatusFixture({
        consent: { acceptedAt: ACCEPTED_AT, planHash: "h" },
        setup: { stage: "done", state: "done" },
      }),
    );

    expect(shownLines()).toEqual(["host-settings-card-moved"]);
    expect(screen.getByTestId("host-settings-card-moved").textContent).toBe(
      `Moved to Personal on ${new Date(ACCEPTED_AT).toLocaleDateString(
        undefined,
        {
          day: "numeric",
          month: "short",
        },
      )}`,
    );
  });

  it("shows none of these lines with no consent on record", () => {
    renderCard(environmentStatusFixture({ setup: null }));
    expect(shownLines()).toEqual([]);
    cleanup();
    renderCard(
      environmentStatusFixture({ setup: { stage: "done", state: "done" } }),
    );
    expect(shownLines()).toEqual([]);
  });
});

describe("hostSettingsCardState", () => {
  it("reads moved off status.consent when setup has not started or has left the move", () => {
    const consent = { acceptedAt: ACCEPTED_AT, planHash: "h" };
    expect(
      hostSettingsCardState(environmentStatusFixture({ consent, setup: null })),
    ).toEqual({ kind: "moved", acceptedAt: ACCEPTED_AT });
    expect(hostSettingsCardState(environmentStatusFixture({}))).toEqual({
      kind: "other",
    });
  });
});
