import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { AddHostDialog } from "@/components/settings/host-scope/add-host-dialog";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";

/**
 * The arrival watcher's contract: announce a host that was NOT in the last
 * COMPLETE picture of the account, and say only what is true of it. Both
 * halves broke in different releases:
 *
 *   - requiring `connectable` stranded free-plan users, whose newly enrolled
 *     remote hosts stay non-connectable by design — the dialog watched forever
 *     over a host already in the account;
 *   - trusting the click-time snapshot let a dialog opened during a list
 *     failure diff against an empty baseline, so the failed list's PRE-EXISTING
 *     hosts were announced as the new machine when the retry landed.
 */

const scopeMocks: { scope: Partial<HostScope> } = vi.hoisted(() => ({
  scope: {},
}));

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } = await import(
    "@/components/settings/host-scope/host-scope-fixture"
  );
  return {
    useHostScope: () => hostScopeFixture(scopeMocks.scope),
  };
});

beforeEach(() => {
  useAddHostDialogStore.getState().closeDialog();
});

afterEach(() => {
  cleanup();
  useAddHostDialogStore.getState().closeDialog();
  scopeMocks.scope = {};
});

async function hostOption(overrides: {
  readonly hostId: string;
  readonly name: string;
  readonly registered: boolean;
  readonly connectable: boolean;
}) {
  const { hostScopeOptionFixture } = await import(
    "@/components/settings/host-scope/host-scope-fixture"
  );
  return hostScopeOptionFixture(overrides);
}

describe("<AddHostDialog /> arrival", () => {
  it("announces a registered host the plan keeps non-connectable", async () => {
    // The free-plan case: the remote machine enrolled, the registry lists it,
    // and the plan gate keeps `connectable` false forever. `registered &&
    // connectable` spun on "Watching…" here for good.
    const newcomer = await hostOption({
      hostId: "host-new",
      name: "Office Linux",
      registered: true,
      connectable: false,
    });
    scopeMocks.scope = { hosts: [newcomer], isLoading: false, listsFailed: false };
    useAddHostDialogStore.getState().openDialog([]);

    render(<AddHostDialog />);

    expect(screen.getByTestId("add-host-arrived")).not.toBeNull();
    // ...and the copy claims registration, not a connection that is not there.
    expect(screen.getByText("Office Linux is registered")).not.toBeNull();
    expect(screen.queryByText(/ready to run agents/)).toBeNull();
  });

  it("still claims a connection for a host it can actually dial", async () => {
    const newcomer = await hostOption({
      hostId: "host-new",
      name: "Office Linux",
      registered: true,
      connectable: true,
    });
    scopeMocks.scope = { hosts: [newcomer], isLoading: false, listsFailed: false };
    useAddHostDialogStore.getState().openDialog([]);

    render(<AddHostDialog />);

    expect(screen.getByText("Office Linux is connected")).not.toBeNull();
    expect(screen.getByText(/ready to run agents/)).not.toBeNull();
  });

  it("does not announce a pre-existing host revealed by a recovered list", async () => {
    // Open while the registry request is failed: the click-time snapshot is
    // EMPTY, and the union is about to gain every host the failed list was
    // hiding. Diffing against that snapshot announced one of them as the new
    // machine. The baseline instead waits for the first complete picture, so
    // the recovered host lands inside it and the dialog keeps watching.
    const preExisting = await hostOption({
      hostId: "host-old",
      name: "Old Faithful",
      registered: true,
      connectable: true,
    });
    scopeMocks.scope = { hosts: [], isLoading: false, listsFailed: true };
    useAddHostDialogStore.getState().openDialog([]);

    const { rerender } = render(<AddHostDialog />);
    expect(screen.queryByTestId("add-host-arrived")).toBeNull();

    // The retry lands: the union now holds the pre-existing host.
    scopeMocks.scope = {
      hosts: [preExisting],
      isLoading: false,
      listsFailed: false,
    };
    rerender(<AddHostDialog />);

    // Not an arrival — it forms the baseline. Still watching.
    expect(screen.queryByTestId("add-host-arrived")).toBeNull();

    // A host that appears AFTER the complete picture is the real newcomer.
    const newcomer = await hostOption({
      hostId: "host-new",
      name: "Office Linux",
      registered: true,
      connectable: true,
    });
    scopeMocks.scope = {
      hosts: [preExisting, newcomer],
      isLoading: false,
      listsFailed: false,
    };
    rerender(<AddHostDialog />);

    expect(screen.getByTestId("add-host-arrived")).not.toBeNull();
    expect(screen.getByText("Office Linux is connected")).not.toBeNull();
  });

  it("does not announce a directory-only row that never registered", async () => {
    // The counterweight the old `&& connectable` half was protecting: a row
    // this client can dial but the account does not know is not an enrollment.
    const unregistered = await hostOption({
      hostId: "host-dial-only",
      name: "Mystery Box",
      registered: false,
      connectable: true,
    });
    scopeMocks.scope = {
      hosts: [unregistered],
      isLoading: false,
      listsFailed: false,
    };
    useAddHostDialogStore.getState().openDialog([]);

    render(<AddHostDialog />);

    expect(screen.queryByTestId("add-host-arrived")).toBeNull();
  });
});
