import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  listHistoryLandingDrafts,
  isHistoryListedLandingDraft,
} from "@/lib/history-landing-drafts";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function draft(overrides: Partial<LandingDraftTab>): LandingDraftTab {
  return {
    id: "draft-1",
    content: textContent("kept prompt"),
    selection: null,
    lastTouchedAt: 100,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    ...freshLandingMirrorState(),
    ...overrides,
  };
}

describe("listHistoryLandingDrafts", () => {
  it("lists open and closed landing drafts, most recent first", () => {
    const listed = listHistoryLandingDrafts({
      drafts: [
        draft({
          id: "older",
          content: textContent("older line"),
          lastTouchedAt: 1,
          closed: true,
        }),
        draft({
          id: "newer",
          content: textContent("newer line"),
          lastTouchedAt: 9,
          closed: false,
        }),
      ],
      query: "",
      excludeDraftId: null,
    });

    expect(listed.map((row) => row.id)).toEqual(["newer", "older"]);
    expect(listed[0]?.closed).toBe(false);
    expect(listed[1]?.closed).toBe(true);
    expect(listed[0]?.title).toBe("newer line");
  });

  it("lists every non-empty draft regardless of ownership - replica, foreign-owned, local and unadopted alike - and excludes only empty content", () => {
    const replica = draft({
      id: "replica",
      origin: "replica",
      ownerHostId: "host-b",
    });
    const foreign = draft({
      id: "foreign",
      origin: "own",
      ownerHostId: "host-b",
    });
    const local = draft({
      id: "local",
      origin: "own",
      ownerHostId: "host-a",
    });
    const unadopted = draft({
      id: "unadopted",
      origin: null,
      ownerHostId: null,
    });
    const empty = draft({
      id: "empty",
      origin: "own",
      ownerHostId: "host-a",
      content: { type: "doc", content: [] },
    });

    expect(isHistoryListedLandingDraft(replica)).toBe(true);
    expect(isHistoryListedLandingDraft(foreign)).toBe(true);
    expect(isHistoryListedLandingDraft(local)).toBe(true);
    expect(isHistoryListedLandingDraft(unadopted)).toBe(true);
    expect(isHistoryListedLandingDraft(empty)).toBe(false);

    expect(
      listHistoryLandingDrafts({
        drafts: [replica, foreign, local, unadopted, empty],
        query: "",
        excludeDraftId: null,
      }).map((row) => row.id),
    ).toEqual(
      expect.arrayContaining(["replica", "foreign", "local", "unadopted"]),
    );
    expect(
      listHistoryLandingDrafts({
        drafts: [replica, foreign, local, unadopted, empty],
        query: "",
        excludeDraftId: null,
      }),
    ).toHaveLength(4);
  });

  it("leaves out the draft the composer above it is editing", () => {
    const typing = draft({ id: "typing", content: textContent("typing now") });
    const retained = draft({
      id: "retained",
      content: textContent("put away"),
      closed: true,
    });

    expect(
      listHistoryLandingDrafts({
        drafts: [typing, retained],
        query: "",
        excludeDraftId: "typing",
      }).map((row) => row.id),
    ).toEqual(["retained"]);
  });

  it("filters by derived title and surfaces workspace when present", () => {
    const withWorkspace = draft({
      id: "ws",
      content: textContent("ship the drafts facet"),
      workspace: {
        folders: ["/Users/me/app"],
        folderInfoByPath: {},
        primaryPath: "/Users/me/app",
      },
      lastTouchedAt: 5,
    });
    const other = draft({
      id: "other",
      content: textContent("unrelated"),
      lastTouchedAt: 6,
    });

    expect(
      listHistoryLandingDrafts({
        drafts: [withWorkspace, other],
        query: "drafts facet",
        excludeDraftId: null,
      }),
    ).toEqual([
      {
        id: "ws",
        title: "ship the drafts facet",
        lastTouchedAt: 5,
        workspacePath: "/Users/me/app",
        closed: false,
      },
    ]);
  });
});
