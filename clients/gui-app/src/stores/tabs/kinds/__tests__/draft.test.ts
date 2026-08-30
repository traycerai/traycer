import { describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { draftTabModule } from "@/stores/tabs/kinds/draft";
import {
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import type { OpenInNewWindowDeps } from "@/stores/tabs/types";
import type {
  DesktopOwnershipClaimResult,
  DesktopPerWindowSnapshot,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import type { EpicNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";

function draft(content: JsonContent): LandingDraftTab {
  return {
    id: "draft-1",
    content,
    selection: null,
    lastTouchedAt: 0,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
  };
}

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

describe("draftTabModule.build name", () => {
  it("falls back to 'Start Page' for empty content", () => {
    expect(draftTabModule.build(draft(EMPTY_LANDING_DRAFT_CONTENT)).name).toBe(
      "Start Page",
    );
  });

  it("derives the label from the first line of typed content", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first line" }] },
        { type: "paragraph", content: [{ type: "text", text: "second line" }] },
      ],
    };
    expect(draftTabModule.build(draft(content)).name).toBe("first line");
  });

  it("trims surrounding whitespace from the derived label", () => {
    expect(draftTabModule.build(draft(textContent("  spaced  "))).name).toBe(
      "spaced",
    );
  });

  it("falls back to 'Start Page' for image-only content (no derived text)", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                fileName: "shot.png",
                hash: "abc123",
                mimeType: "image/png",
                size: 3,
              },
            },
          ],
        },
      ],
    };
    expect(draftTabModule.build(draft(content)).name).toBe("Start Page");
  });
});

describe("draftTabModule.build canOpenInNewWindow", () => {
  it("is always true for a draft tab - a draft's whole substance is its per-window record", () => {
    expect(
      draftTabModule.build(draft(EMPTY_LANDING_DRAFT_CONTENT))
        .canOpenInNewWindow,
    ).toBe(true);
  });
});

function emptyPerWindowSnapshot(): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    tabStripLayout: null,
    activeRoute: null,
  };
}

/**
 * Neither `bridge` nor `epicFlow` is read by the draft kind's
 * `openInNewWindow` (only `draftFlow` is - see the module under test), so
 * these are inert structural doubles: present to satisfy `OpenInNewWindowDeps`,
 * never expected to be called.
 */
function buildInertBridge(): DesktopWindowsBridge {
  const claimResult: DesktopOwnershipClaimResult = { ok: true };
  return {
    windowId: "window-a",
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.reject(new Error("not used by draftTabModule.openInNewWindow")),
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve(claimResult),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () => Promise.resolve(emptyPerWindowSnapshot()),
      update: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({ status: "signed-out", token: null, profile: null }),
      set: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function buildInertEpicFlow(): EpicNewWindowFlow {
  return {
    isAvailable: true,
    pendingMove: null,
    requestOpenInNewWindow: () => undefined,
    waitForSync: () => undefined,
    cancelMove: () => undefined,
    discardAndMove: () => undefined,
  };
}

describe("draftTabModule.descriptor.openInNewWindow", () => {
  it("delegates to deps.draftFlow.requestOpenInNewWindow with the tab's draft id", () => {
    const tab = draftTabModule.build(draft(EMPTY_LANDING_DRAFT_CONTENT));
    const requestOpenInNewWindow = vi.fn();
    const deps: OpenInNewWindowDeps = {
      bridge: buildInertBridge(),
      epicFlow: buildInertEpicFlow(),
      draftFlow: { requestOpenInNewWindow },
    };

    draftTabModule.descriptor.openInNewWindow(tab, deps);

    expect(requestOpenInNewWindow).toHaveBeenCalledTimes(1);
    expect(requestOpenInNewWindow).toHaveBeenCalledWith({ draftId: "draft-1" });
  });
});
