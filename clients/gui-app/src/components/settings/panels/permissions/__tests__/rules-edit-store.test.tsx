import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginRulesEditHandoff,
  cancelRulesEditHandoff,
  readRulesEditForTests,
  resetRulesEditForTests,
  useRulesEdit,
  useRulesEditLifetime,
  type RulesEditHandle,
} from "@/components/settings/panels/permissions/rules-edit-store";
import { EMPTY_AUTO_POLICY_SECTIONS } from "@/components/settings/panels/auto-policy-document";
import type { RulesEditorState } from "@/components/settings/panels/permissions/rules-tab";
import type { SettingsRuleDraft } from "@/stores/tabs/system-overlay-types";

const viewer = vi.hoisted((): { current: string } => ({ current: "viewer-a" }));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: (): string => viewer.current,
}));

const DRAFT: SettingsRuleDraft = { section: "allow", text: "drafted" };
const OTHER_DRAFT: SettingsRuleDraft = { section: "hardDeny", text: "other" };

const SNAP_A: RulesEditorState = {
  recordKey: "record-a",
  readState: "fresh",
  baseline: EMPTY_AUTO_POLICY_SECTIONS,
  sections: EMPTY_AUTO_POLICY_SECTIONS,
  loadedUpdatedAt: null,
  reorders: false,
  drafted: [],
  appliedDraftId: 0,
  scrollRequest: null,
};

function renderEdit(): {
  readonly current: () => RulesEditHandle;
  readonly rerender: () => void;
} {
  const hook = renderHook(() => useRulesEdit());
  return {
    current: () => hook.result.current,
    rerender: () => hook.rerender(),
  };
}

beforeEach(() => {
  viewer.current = "viewer-a";
  resetRulesEditForTests();
});
afterEach(() => {
  resetRulesEditForTests();
});

describe("useRulesEdit viewer partition", () => {
  it("hides another viewer's snapshot and drafts on read", () => {
    const first = renderEdit();
    act(() => {
      first.current().enqueueDraft(DRAFT);
      first.current().onSnapshot(SNAP_A);
    });
    expect(first.current().edit.drafts).toHaveLength(1);

    viewer.current = "viewer-b";
    const second = renderEdit();

    expect(second.current().edit.snapshot).toBeNull();
    expect(second.current().edit.drafts).toEqual([]);
  });

  it("drops the other viewer's edit permanently, on write", () => {
    const first = renderEdit();
    act(() => {
      first.current().enqueueDraft(DRAFT);
    });
    viewer.current = "viewer-b";
    const second = renderEdit();
    expect(second.current().edit.drafts).toEqual([]);

    viewer.current = "viewer-a";
    const third = renderEdit();

    expect(third.current().edit.drafts).toEqual([]);
    expect(readRulesEditForTests().edit.drafts).toEqual([]);
  });

  it("adopts the edit when an unknown viewer becomes known", () => {
    viewer.current = "";
    const unknown = renderEdit();
    act(() => {
      unknown.current().enqueueDraft(DRAFT);
    });

    viewer.current = "viewer-a";
    const known = renderEdit();

    expect(known.current().edit.viewerId).toBe("viewer-a");
    expect(known.current().edit.drafts).toHaveLength(1);
  });

  it("keeps the edit when the viewer signs out", () => {
    const signedIn = renderEdit();
    act(() => {
      signedIn.current().enqueueDraft(DRAFT);
    });

    viewer.current = "";
    const signedOut = renderEdit();

    expect(signedOut.current().edit.drafts).toHaveLength(1);
    expect(readRulesEditForTests().edit.viewerId).toBe("viewer-a");
  });
});

describe("useRulesEdit drafts", () => {
  it("queues an intent's draft once per intent id", () => {
    const edit = renderEdit();
    act(() => {
      edit.current().enqueueIntentDraft(7, DRAFT);
      edit.current().enqueueIntentDraft(7, DRAFT);
    });
    expect(edit.current().edit.drafts).toHaveLength(1);

    act(() => {
      edit.current().enqueueIntentDraft(8, OTHER_DRAFT);
    });
    expect(edit.current().edit.drafts).toHaveLength(2);
  });

  it("counts enqueueDraft ids up, and consuming removes through an id", () => {
    const edit = renderEdit();
    act(() => {
      edit.current().enqueueDraft(DRAFT);
      edit.current().enqueueDraft(OTHER_DRAFT);
    });
    expect(edit.current().edit.drafts.map((entry) => entry.id)).toEqual([1, 2]);

    act(() => {
      edit.current().onDraftsConsumed(1);
    });
    expect(edit.current().edit.drafts.map((entry) => entry.id)).toEqual([2]);
  });
});

interface LifetimeProps {
  readonly open: boolean;
  readonly tab: boolean;
}

function renderLifetime(initial: LifetimeProps) {
  return renderHook(
    (props: LifetimeProps) => {
      useRulesEditLifetime(props.open, props.tab);
    },
    { initialProps: initial },
  );
}

function seedEdit(): void {
  const edit = renderEdit();
  act(() => {
    edit.current().enqueueDraft(DRAFT);
  });
}

function editKept(): boolean {
  return readRulesEditForTests().edit.drafts.length === 1;
}

describe("useRulesEditLifetime", () => {
  it("resets only on the open to closed transition", () => {
    seedEdit();
    const lifetime = renderLifetime({ open: true, tab: false });
    expect(editKept()).toBe(true);

    lifetime.rerender({ open: true, tab: false });
    expect(editKept()).toBe(true);

    lifetime.rerender({ open: false, tab: false });
    expect(editKept()).toBe(false);
  });

  it("does not reset when it mounts open", () => {
    seedEdit();
    renderLifetime({ open: true, tab: false });
    expect(editKept()).toBe(true);
  });

  it("GAP: a closed frame during a handoff keeps the edit, the tab's arrival ends it, a later close resets", () => {
    seedEdit();
    const lifetime = renderLifetime({ open: true, tab: false });

    act(() => {
      beginRulesEditHandoff();
    });
    lifetime.rerender({ open: false, tab: false });
    expect(editKept()).toBe(true);
    expect(readRulesEditForTests().handoffPending).toBe(true);

    lifetime.rerender({ open: true, tab: true });
    expect(readRulesEditForTests().handoffPending).toBe(false);
    expect(editKept()).toBe(true);

    lifetime.rerender({ open: false, tab: false });
    expect(editKept()).toBe(false);
  });

  it("SAME-COMMIT SWAP: modal gone and tab present in one commit clears the flag, a later close resets", () => {
    seedEdit();
    const lifetime = renderLifetime({ open: true, tab: false });

    act(() => {
      beginRulesEditHandoff();
    });
    lifetime.rerender({ open: true, tab: true });

    expect(readRulesEditForTests().handoffPending).toBe(false);
    expect(editKept()).toBe(true);

    lifetime.rerender({ open: false, tab: false });
    expect(editKept()).toBe(false);
  });

  it("CANCEL: a cancelled handoff makes the next close a reset", () => {
    seedEdit();
    const lifetime = renderLifetime({ open: true, tab: false });

    act(() => {
      beginRulesEditHandoff();
      cancelRulesEditHandoff();
    });
    lifetime.rerender({ open: false, tab: false });

    expect(editKept()).toBe(false);
  });
});
