import { describe, expect, it } from "vitest";
import {
  deletedEpicSuccessToastMessage,
  pickNeighborAfterDeletingEpics,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import type { HeaderTab } from "@/stores/tabs/types";

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
