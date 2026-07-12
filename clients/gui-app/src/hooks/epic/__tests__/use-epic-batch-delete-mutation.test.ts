import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { ExternalToast } from "sonner";

const toastWarning = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "warning-toast",
  ),
);

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: toastWarning,
    error: vi.fn(),
  },
}));

import {
  deletedEpicSuccessToastMessage,
  emitEpicDeleteToast,
  pickNeighborAfterDeletingEpics,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type { HeaderTab } from "@/stores/tabs/types";

beforeEach(() => {
  toastWarning.mockClear();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

afterEach(() => {
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

function epicTab(id: string, epicId: string): HeaderTab {
  return {
    kind: "epic",
    id,
    epicId,
    route: `/epics/${epicId}/${id}`,
    name: epicId,
    icon: null,
    canDuplicate: true,
    canOpenInNewWindow: true,
  };
}

function historyTab(): HeaderTab {
  return {
    kind: "history",
    id: "history",
    route: "/epics",
    name: "History",
    icon: null,
    canDuplicate: false,
    canOpenInNewWindow: false,
    lastPath: null,
  };
}

function draftTab(id: string): HeaderTab {
  return {
    kind: "draft",
    id,
    route: `/draft/${id}`,
    name: "Draft",
    icon: null,
    canDuplicate: false,
    canOpenInNewWindow: false,
  };
}

describe("pickNeighborAfterDeletingEpics", () => {
  it("picks the neighboring tab when the active route epic is deleted", () => {
    const first = epicTab("tab-a", "epic-a");
    const deleted = epicTab("tab-b", "epic-b");
    const third = epicTab("tab-c", "epic-c");

    expect(
      pickNeighborAfterDeletingEpics(
        [first, deleted, third],
        deleted.route,
        new Set(["epic-b"]),
      ),
    ).toBe(first);
  });

  it("can route to a draft neighbor after deleting the active epic", () => {
    const deleted = epicTab("tab-a", "epic-a");
    const draft = draftTab("draft-a");

    expect(
      pickNeighborAfterDeletingEpics(
        [deleted, draft],
        deleted.route,
        new Set(["epic-a"]),
      ),
    ).toBe(draft);
  });

  it("ignores History when deleting the only work tab", () => {
    const deleted = epicTab("tab-a", "epic-a");
    const history = historyTab();

    expect(
      pickNeighborAfterDeletingEpics(
        [deleted, history],
        deleted.route,
        new Set(["epic-a"]),
      ),
    ).toBeNull();
  });

  it("skips History while preserving the left-neighbor preference", () => {
    const first = epicTab("tab-a", "epic-a");
    const history = historyTab();
    const deleted = epicTab("tab-b", "epic-b");
    const third = epicTab("tab-c", "epic-c");

    expect(
      pickNeighborAfterDeletingEpics(
        [first, history, deleted, third],
        deleted.route,
        new Set(["epic-b"]),
      ),
    ).toBe(first);
  });

  it("returns null when deleting the active epic leaves no tabs", () => {
    const deleted = epicTab("tab-a", "epic-a");

    expect(
      pickNeighborAfterDeletingEpics(
        [deleted],
        deleted.route,
        new Set(["epic-a"]),
      ),
    ).toBeNull();
  });

  it("does not navigate when the active route epic was not deleted", () => {
    const active = epicTab("tab-a", "epic-a");
    const deleted = epicTab("tab-b", "epic-b");

    expect(
      pickNeighborAfterDeletingEpics(
        [active, deleted],
        active.route,
        new Set(["epic-b"]),
      ),
    ).toBeUndefined();
  });
});

describe("deletedEpicSuccessToastMessage", () => {
  it("includes the deleted epic title for a single successful delete", () => {
    expect(
      deletedEpicSuccessToastMessage(["epic-a"], {
        "epic-a": "Customer onboarding",
      }),
    ).toBe('Epic "Customer onboarding" was deleted');
  });

  it("falls back without the generic past-tense noun when the title is absent", () => {
    expect(deletedEpicSuccessToastMessage(["epic-a"], {})).toBe(
      "Epic was deleted",
    );
  });

  it("keeps the count message for bulk deletes", () => {
    expect(
      deletedEpicSuccessToastMessage(["epic-a", "epic-b"], {
        "epic-a": "Customer onboarding",
        "epic-b": "Release notes",
      }),
    ).toBe("2 epics deleted");
  });
});

describe("emitEpicDeleteToast", () => {
  it("keeps partial deletions as warnings with fixed report context", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    emitEpicDeleteToast("warning", "Deleted 1 of 2; 1 failed.");

    expect(toastWarning.mock.lastCall?.[0]).toBe("Deleted 1 of 2; 1 failed.");
    expect(readWarningOptions().cancel).toMatchObject({
      label: "Report issue",
    });
    clickWarningReportAction();
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Epic deletion incomplete",
      message: null,
      code: null,
      source: "Epic deletion",
    });
    expect(
      JSON.stringify(useDesktopDialogStore.getState().reportIssueContext),
    ).not.toMatch(/epic-[a-z0-9]+|Customer onboarding|Deleted 1 of 2/);
  });

  it("does not expose reporting when the capability is unavailable", () => {
    emitEpicDeleteToast("warning", "Deleted 1 of 2; 1 failed.");

    expect(toastWarning).toHaveBeenCalledWith("Deleted 1 of 2; 1 failed.");
  });
});

function clickWarningReportAction(): void {
  const cancel = readWarningOptions().cancel;
  if (typeof cancel !== "object" || cancel === null || !("onClick" in cancel)) {
    throw new Error("Expected a warning report action.");
  }
  const action = render(
    createElement(
      "button",
      { type: "button", onClick: cancel.onClick },
      "Trigger warning report",
    ),
  );
  fireEvent.click(
    action.getByRole("button", { name: "Trigger warning report" }),
  );
  action.unmount();
}

function readWarningOptions(): ExternalToast {
  const options = toastWarning.mock.lastCall?.[1];
  if (options === undefined) {
    throw new Error("Expected warning toast options.");
  }
  return options;
}
