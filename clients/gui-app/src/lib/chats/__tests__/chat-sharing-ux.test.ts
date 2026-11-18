import { describe, expect, it } from "vitest";
import {
  countOwnPrivateChats,
  decideChatSharingMenuEntry,
  deriveChatSharingDefaultOn,
  shouldShowSharedWithTaskIndicator,
  taskHasCollaborators,
  UNPUBLISHED_SHARING_TOOLTIP,
} from "@/lib/chats/chat-sharing-ux";

describe("decideChatSharingMenuEntry", () => {
  it("hides the entry when the host does not advertise the RPC", () => {
    expect(
      decideChatSharingMenuEntry({
        supported: false,
        isChat: true,
        canMutate: true,
        visibility: "private",
        pending: false,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("hides the entry on terminal-agent rows", () => {
    expect(
      decideChatSharingMenuEntry({
        supported: true,
        isChat: false,
        canMutate: true,
        visibility: "private",
        pending: false,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("offers Share with task when the folded cloud row is private", () => {
    expect(
      decideChatSharingMenuEntry({
        supported: true,
        isChat: true,
        canMutate: true,
        visibility: "private",
        pending: false,
      }),
    ).toEqual({
      kind: "entry",
      action: "share",
      disabled: false,
      disabledTooltip: null,
    });
  });

  it("offers Make private when the folded cloud row is task-visible", () => {
    expect(
      decideChatSharingMenuEntry({
        supported: true,
        isChat: true,
        canMutate: true,
        visibility: "task",
        pending: false,
      }),
    ).toEqual({
      kind: "entry",
      action: "make-private",
      disabled: false,
      disabledTooltip: null,
    });
  });

  it("disables the unpublished arm with the publishes-shortly tooltip", () => {
    expect(
      decideChatSharingMenuEntry({
        supported: true,
        isChat: true,
        canMutate: true,
        visibility: null,
        pending: false,
      }),
    ).toEqual({
      kind: "entry",
      action: "share",
      disabled: true,
      disabledTooltip: UNPUBLISHED_SHARING_TOOLTIP,
    });
  });

  it("disables every entry while a sharing write is in flight", () => {
    expect(
      decideChatSharingMenuEntry({
        supported: true,
        isChat: true,
        canMutate: true,
        visibility: "task",
        pending: true,
      }),
    ).toEqual({
      kind: "entry",
      action: "make-private",
      disabled: true,
      disabledTooltip: null,
    });
  });

  it("greys the entry out without a tooltip when the viewer cannot mutate", () => {
    expect(
      decideChatSharingMenuEntry({
        supported: true,
        isChat: true,
        canMutate: false,
        visibility: "private",
        pending: false,
      }),
    ).toEqual({
      kind: "entry",
      action: "share",
      disabled: true,
      disabledTooltip: null,
    });
  });
});

describe("shouldShowSharedWithTaskIndicator", () => {
  it("shows only when the row is task-visible and the task has collaborators", () => {
    expect(
      shouldShowSharedWithTaskIndicator({
        visibility: "task",
        hasCollaborators: true,
      }),
    ).toBe(true);
    expect(
      shouldShowSharedWithTaskIndicator({
        visibility: "task",
        hasCollaborators: false,
      }),
    ).toBe(false);
    expect(
      shouldShowSharedWithTaskIndicator({
        visibility: "private",
        hasCollaborators: true,
      }),
    ).toBe(false);
    expect(
      shouldShowSharedWithTaskIndicator({
        visibility: null,
        hasCollaborators: true,
      }),
    ).toBe(false);
  });
});

describe("master-toggle derivation", () => {
  it("is off when every own row is private, including when there are none", () => {
    expect(deriveChatSharingDefaultOn([])).toBe(false);
    expect(deriveChatSharingDefaultOn([{ visibility: "private" }])).toBe(false);
  });

  it("is on when any own row is task-visible", () => {
    expect(
      deriveChatSharingDefaultOn([
        { visibility: "private" },
        { visibility: "task" },
      ]),
    ).toBe(true);
  });

  it("counts own private rows as the share-direction confirm number", () => {
    expect(countOwnPrivateChats([])).toBe(0);
    expect(
      countOwnPrivateChats([
        { visibility: "private" },
        { visibility: "task" },
        { visibility: "private" },
      ]),
    ).toBe(2);
  });
});

describe("taskHasCollaborators", () => {
  it("is false while the query has not answered, and for a solo owner", () => {
    expect(taskHasCollaborators(undefined)).toBe(false);
    expect(taskHasCollaborators({ directUsers: [{}], teams: [] })).toBe(false);
  });

  it("is true once a second person or a team grant is present", () => {
    expect(taskHasCollaborators({ directUsers: [{}, {}], teams: [] })).toBe(
      true,
    );
    expect(taskHasCollaborators({ directUsers: [{}], teams: [{}] })).toBe(true);
  });
});
