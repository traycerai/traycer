import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HOST_FROZEN_WORD } from "@traycer/protocol/host/host-status";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import { AVAILABLE_HOST_ROW_SURFACE_STATE } from "@/components/settings/host-scope/host-option-model";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";

// The row half: `HostOptionRow` renders EXACTLY the
// `updateView` prop it was handed, and nothing else - the isolation the hook
// test (`use-fleet-update-views.test.tsx`) proves at the data source, this
// proves at the LAST consumer, so a future prop threaded through some shared
// context (breaking the "opt-in by data, not a flag" design the component's
// own doc comment calls out) would be caught here even if the hook stayed
// correct.
//
// Also pins the row's OTHER isolation property: it is pure content, with no
// interactive element of its own for any banner/update state to disable -
// `HostSwitcher`'s cmdk `CommandItem` is the only thing that can ever gate
// selection, so proving the row emits none is what makes "no update state
// disables a row" a structural fact instead of a per-badge checklist.

function fleetView(overrides: Partial<FleetUpdateView>): FleetUpdateView {
  // Built by spreading the shared "we know nothing" constant rather than
  // hand-writing every field: a new field on `FleetUpdateView` should not need
  // an edit in each fixture, and a fixture that lists fields explicitly quietly
  // becomes a second definition of the type.
  return {
    ...UNKNOWN_FLEET_UPDATE_VIEW,
    kind: "idle",
    qualified: false,
    ...overrides,
  };
}

describe("HostOptionRow — per-host update badge isolation (Ticket 06 subject F)", () => {
  // This suite has no RTL auto-cleanup configured (confirmed project-wide
  // gap) - without this, `queryByTestId` in a later test can match a DOM node
  // left mounted by an earlier one, since these tests intentionally reuse the
  // same host-a/host-b testids across cases.
  afterEach(cleanup);

  it("renders each row's badge from its OWN updateView prop only, independent of a sibling row's state", () => {
    const hostA = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const hostB = hostScopeOptionFixture({ hostId: "host-b", name: "Host B" });
    const viewA = fleetView({ kind: "downloading" });
    const viewB = fleetView({ kind: "idle" });

    const { getByTestId, queryByTestId } = render(
      <>
        <HostOptionRow
          host={hostA}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={viewA}
          nameRef={null}
          environmentLabel={null}
        />
        <HostOptionRow
          host={hostB}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={viewB}
          nameRef={null}
          environmentLabel={null}
        />
      </>,
    );

    expect(getByTestId("host-option-update-badge-host-a").textContent).toBe(
      "updating",
    );
    // The isolation claim: B's idle view renders NO badge at all, not a stale
    // or shared copy of A's.
    expect(queryByTestId("host-option-update-badge-host-b")).toBeNull();
  });

  it("positive control: swapping which row holds the active view moves the badge with it, proving the isolation claim above could fail", () => {
    const hostA = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const hostB = hostScopeOptionFixture({ hostId: "host-b", name: "Host B" });

    const { getByTestId, queryByTestId, rerender } = render(
      <>
        <HostOptionRow
          host={hostA}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "idle" })}
          nameRef={null}
          environmentLabel={null}
        />
        <HostOptionRow
          host={hostB}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "failed" })}
          nameRef={null}
          environmentLabel={null}
        />
      </>,
    );
    expect(queryByTestId("host-option-update-badge-host-a")).toBeNull();
    expect(getByTestId("host-option-update-badge-host-b").textContent).toBe(
      "update failed",
    );

    rerender(
      <>
        <HostOptionRow
          host={hostA}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "failed" })}
          nameRef={null}
          environmentLabel={null}
        />
        <HostOptionRow
          host={hostB}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "idle" })}
          nameRef={null}
          environmentLabel={null}
        />
      </>,
    );
    expect(getByTestId("host-option-update-badge-host-a").textContent).toBe(
      "update failed",
    );
    expect(queryByTestId("host-option-update-badge-host-b")).toBeNull();
  });

  it("a `null` updateView (every non-Settings picker) renders no badge — opt-in by data, never a default", () => {
    const host = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const { queryByTestId } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={null}
        nameRef={null}
        environmentLabel={null}
      />,
    );
    expect(queryByTestId("host-option-update-badge-host-a")).toBeNull();
  });

  it("an active update state renders no interactive or disable-able element — the row itself cannot gate selection", () => {
    const host = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const { container } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={fleetView({
          kind: "waiting-for-work",
          blockingSessionCount: 3,
        })}
        nameRef={null}
        environmentLabel={null}
      />,
    );
    // Structural, not a checklist of specific attributes: NOTHING this row
    // renders is a button, link, or anything carrying `disabled` /
    // `aria-disabled` — every one of those properties belongs to whatever
    // container (`CommandItem`, a dialog radio) wraps this content.
    expect(
      container.querySelectorAll("button, a, [role='button']"),
    ).toHaveLength(0);
    expect(container.querySelectorAll("[disabled]")).toHaveLength(0);
    expect(container.querySelectorAll("[aria-disabled]")).toHaveLength(0);
  });
});

describe("HostOptionRow — environment label (Tracy Bots)", () => {
  afterEach(cleanup);

  it("renders the environment label beside the name when one is passed", () => {
    const host = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const { getByTestId } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={null}
        nameRef={null}
        environmentLabel="acme"
      />,
    );
    expect(getByTestId("host-option-environment-host-a").textContent).toBe(
      "acme",
    );
  });

  it("renders no environment element for a null label (every picker but Settings)", () => {
    const host = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const { queryByTestId } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={null}
        nameRef={null}
        environmentLabel={null}
      />,
    );
    expect(queryByTestId("host-option-environment-host-a")).toBeNull();
  });

  it("keys the label by its own host, so sibling rows carry independent labels", () => {
    const hostA = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const hostB = hostScopeOptionFixture({ hostId: "host-b", name: "Host B" });
    const { getByTestId, queryByTestId } = render(
      <>
        <HostOptionRow
          host={hostA}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={null}
          nameRef={null}
          environmentLabel="acme"
        />
        <HostOptionRow
          host={hostB}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={null}
          nameRef={null}
          environmentLabel={null}
        />
      </>,
    );
    expect(getByTestId("host-option-environment-host-a").textContent).toBe(
      "acme",
    );
    expect(queryByTestId("host-option-environment-host-b")).toBeNull();
  });
});

describe("HostOptionRow — compact names and marks", () => {
  afterEach(cleanup);

  it("keeps a long name truncated beside its refusal in the merged row", () => {
    const name = "A very long host name that must remain readable";
    const host = hostScopeOptionFixture({
      hostId: "host-long",
      name,
    });
    const { getByText } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="pin"
        surfaceState={{ kind: "refused", word: "needs update" }}
        updateView={null}
        nameRef={null}
        environmentLabel={null}
      />,
    );

    const nameElement = getByText(name);
    expect(nameElement.className.split(/\s+/)).toContain("truncate");
    expect(nameElement.className.split(/\s+/)).toContain("min-w-[8ch]");
    expect(nameElement.getAttribute("title")).toBeNull();
    const nameRow = nameElement.parentElement;
    expect(nameRow?.classList.contains("items-center")).toBe(true);
    const marks = getByText("needs update");
    expect(nameRow?.contains(marks)).toBe(true);
    const marksGroup = marks.parentElement;
    expect(marksGroup?.className.split(/\s+/)).not.toContain("shrink-0");
    expect(marksGroup?.className.split(/\s+/)).toContain("min-w-0");
    expect(marksGroup?.className.split(/\s+/)).toContain("whitespace-nowrap");
    expect(
      nameElement.compareDocumentPosition(marks) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("caps a long environment label and the update badge, with each full text in its tooltip", () => {
    const environmentLabel =
      "A very long environment name that overflows the host list";
    const host = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const { getByTestId } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={fleetView({ kind: "waiting-to-activate" })}
        nameRef={null}
        environmentLabel={environmentLabel}
      />,
    );

    const label = getByTestId("host-option-environment-host-a");
    expect(label.textContent).toBe(environmentLabel);
    expect(label.className.split(/\s+/)).toContain("truncate");
    expect(label.className.split(/\s+/)).toContain("max-w-32");
    expect(tooltipTextNear(label)).toBe(environmentLabel);

    const badge = getByTestId("host-option-update-badge-host-a");
    expect(badge.textContent).toBe("restart to finish");
    expect(badge.className.split(/\s+/)).toContain("truncate");
    expect(badge.className.split(/\s+/)).toContain("max-w-32");
    expect(tooltipTextNear(badge)).toBe("restart to finish");
  });
});

describe("HostOptionRow — frozen sandbox state", () => {
  afterEach(cleanup);

  it("shows Out of credits beside the sandbox's lifecycle word", () => {
    const host = hostScopeOptionFixture({
      hostId: "sandbox-host",
      kind: "sandbox",
      sandbox: {
        state: "suspended",
        frozen: true,
        summary: null,
        teamOwned: false,
      },
    });
    const { getByText } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={null}
        nameRef={null}
        environmentLabel={null}
      />,
    );

    expect(getByText("Suspended", { exact: true })).toBeTruthy();
    expect(getByText(HOST_FROZEN_WORD, { exact: true })).toBeTruthy();
  });
});

describe("HostOptionRow — terminal-run note", () => {
  afterEach(cleanup);

  function renderRow(terminalRunNote: string | null) {
    return render(
      <HostOptionRow
        host={hostScopeOptionFixture({
          hostId: "host-a",
          name: "Host A",
          terminalRunNote,
        })}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={UNKNOWN_FLEET_UPDATE_VIEW}
        nameRef={null}
        environmentLabel={null}
      />,
    );
  }

  it("shows the note as the row's second line, under the name", () => {
    const { getByTestId, getByText } = renderRow("Started from a terminal.");

    expect(getByTestId("host-option-terminal-run-host-a").textContent).toBe(
      "Started from a terminal.",
    );
    expect(getByText("Host A")).toBeDefined();
  });

  it("shows no second line without a note", () => {
    const { queryByTestId } = renderRow(null);

    expect(queryByTestId("host-option-terminal-run-host-a")).toBeNull();
  });
});
