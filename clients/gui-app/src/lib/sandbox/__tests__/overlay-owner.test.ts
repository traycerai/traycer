import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  claimFullscreen,
  holdFullscreenBlocker,
  isFullscreenBlocked,
  releaseFullscreen,
  useFullscreenBlocker,
  useFullscreenPinnedRowKeys,
  yieldFullscreen,
  type FullscreenClaim,
} from "../overlay-owner";

function makeClaim(pinnedRowKey: string | null): FullscreenClaim & {
  readonly exit: Mock<() => void>;
} {
  return { exit: vi.fn<() => void>(), pinnedRowKey };
}

function addDialog(): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  return dialog;
}

/** Lets the document's mutation observers deliver their records. */
async function settleMutations(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Blockers a test holds; released after it, so none leaks into the next. */
const heldBlockers: (() => void)[] = [];
function block(): () => void {
  const release = holdFullscreenBlocker();
  heldBlockers.push(release);
  return release;
}

afterEach(() => {
  // A test that left a claim or a blocker held would leak it into the next.
  for (const release of heldBlockers.splice(0)) release();
  yieldFullscreen();
  document.body.replaceChildren();
});

describe("claiming fullscreen", () => {
  it("refuses a second claim while one is held, and the first keeps it", () => {
    const first = makeClaim(null);
    const second = makeClaim(null);

    expect(claimFullscreen(first)).toBe(true);
    expect(claimFullscreen(second)).toBe(false);

    yieldFullscreen();
    expect(first.exit).toHaveBeenCalledTimes(1);
    expect(second.exit).not.toHaveBeenCalled();
  });

  it("lets the holder claim again, and lets another claim after a release", () => {
    const first = makeClaim(null);
    const second = makeClaim(null);

    expect(claimFullscreen(first)).toBe(true);
    expect(claimFullscreen(first)).toBe(true);
    releaseFullscreen(first);

    expect(claimFullscreen(second)).toBe(true);
  });

  it("a release by a claim that does not hold fullscreen changes nothing", () => {
    const holder = makeClaim(null);
    claimFullscreen(holder);

    releaseFullscreen(makeClaim(null));
    yieldFullscreen();

    expect(holder.exit).toHaveBeenCalledTimes(1);
  });
});

describe("yielding fullscreen", () => {
  it("drops the holder to inline by calling its exit, once", () => {
    const claim = makeClaim(null);
    claimFullscreen(claim);

    yieldFullscreen();
    yieldFullscreen();

    expect(claim.exit).toHaveBeenCalledTimes(1);
    expect(claimFullscreen(makeClaim(null))).toBe(true);
  });

  it("does nothing when no app is fullscreen", () => {
    expect(() => yieldFullscreen()).not.toThrow();
  });

  it("yields when a dialog opens after the claim", async () => {
    const claim = makeClaim(null);
    claimFullscreen(claim);

    addDialog();

    await waitFor(() => expect(claim.exit).toHaveBeenCalledTimes(1));
  });

  it("yields when a dialog arrives inside a larger subtree, including an alertdialog", async () => {
    const claim = makeClaim(null);
    claimFullscreen(claim);

    const portal = document.createElement("div");
    const alert = document.createElement("div");
    alert.setAttribute("role", "alertdialog");
    portal.append(alert);
    document.body.append(portal);

    await waitFor(() => expect(claim.exit).toHaveBeenCalledTimes(1));
  });

  it("yields when a mounted dialog opens in place", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "closed");
    document.body.append(dialog);
    const claim = makeClaim(null);
    expect(claimFullscreen(claim)).toBe(true);

    dialog.setAttribute("data-state", "open");

    await waitFor(() => expect(claim.exit).toHaveBeenCalledTimes(1));
  });

  it("ignores other nodes being added", async () => {
    const claim = makeClaim(null);
    claimFullscreen(claim);

    document.body.append(document.createElement("div"));

    await settleMutations();
    expect(claim.exit).not.toHaveBeenCalled();
  });

  it("yields when focus enters the composer's editor", () => {
    const editor = document.createElement("div");
    editor.setAttribute("data-composer-editor", "");
    const field = document.createElement("div");
    editor.append(field);
    document.body.append(editor);
    const claim = makeClaim(null);
    claimFullscreen(claim);

    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(claim.exit).toHaveBeenCalledTimes(1);
  });

  it("keeps fullscreen when focus moves anywhere else", () => {
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    const claim = makeClaim(null);
    claimFullscreen(claim);

    elsewhere.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(claim.exit).not.toHaveBeenCalled();
  });

  it("stops watching once the claim is released", async () => {
    const claim = makeClaim(null);
    claimFullscreen(claim);
    releaseFullscreen(claim);

    addDialog();

    await settleMutations();
    expect(claim.exit).not.toHaveBeenCalled();
  });
});

describe("blocked while something needs the reader", () => {
  it("refuses every claim while a dialog is open, including one opened before", () => {
    const dialog = addDialog();

    expect(isFullscreenBlocked()).toBe(true);
    expect(claimFullscreen(makeClaim(null))).toBe(false);
    expect(claimFullscreen(makeClaim("message-2"))).toBe(false);

    dialog.remove();
    expect(claimFullscreen(makeClaim(null))).toBe(true);
  });

  it("does not count a mounted dialog that is closed or hidden", () => {
    const closed = addDialog();
    closed.setAttribute("data-state", "closed");
    const hidden = addDialog();
    hidden.hidden = true;

    expect(claimFullscreen(makeClaim(null))).toBe(true);
  });

  it("refuses a claim while focus is in a composer", () => {
    const editor = document.createElement("div");
    editor.setAttribute("data-composer-editor", "");
    const field = document.createElement("textarea");
    editor.append(field);
    document.body.append(editor);
    field.focus();

    expect(claimFullscreen(makeClaim(null))).toBe(false);

    field.blur();
    expect(claimFullscreen(makeClaim(null))).toBe(true);
  });

  it("a held blocker ends the current claim and refuses every claim until released", () => {
    const holder = makeClaim(null);
    expect(claimFullscreen(holder)).toBe(true);

    const release = block();
    expect(holder.exit).toHaveBeenCalledTimes(1);
    // The same app asking again, and any other app, are both refused - as
    // many times as they ask.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(claimFullscreen(holder)).toBe(false);
      expect(claimFullscreen(makeClaim(null))).toBe(false);
    }

    release();
    release();
    expect(claimFullscreen(makeClaim(null))).toBe(true);
  });

  it("stays blocked until every blocker is released", () => {
    const first = block();
    const second = block();

    first();
    expect(claimFullscreen(makeClaim(null))).toBe(false);
    second();
    expect(claimFullscreen(makeClaim(null))).toBe(true);
  });

  it("useFullscreenBlocker holds a blocker for as long as the reader is needed", () => {
    const claim = makeClaim(null);
    claimFullscreen(claim);

    const { rerender, unmount } = renderHook(
      ({ needsReader }) => useFullscreenBlocker(needsReader),
      { initialProps: { needsReader: false } },
    );
    expect(claim.exit).not.toHaveBeenCalled();

    rerender({ needsReader: true });
    expect(claim.exit).toHaveBeenCalledTimes(1);
    expect(claimFullscreen(makeClaim(null))).toBe(false);

    rerender({ needsReader: false });
    expect(isFullscreenBlocked()).toBe(false);

    rerender({ needsReader: true });
    unmount();
    expect(isFullscreenBlocked()).toBe(false);
  });
});

describe("useFullscreenPinnedRowKeys", () => {
  it("follows the claim: pinned while held, empty after a release or a yield", () => {
    const { result } = renderHook(() => useFullscreenPinnedRowKeys());
    expect(result.current).toEqual([]);

    const claim = makeClaim("message-7");
    act(() => {
      claimFullscreen(claim);
    });
    expect(result.current).toEqual(["message-7"]);

    act(() => {
      releaseFullscreen(claim);
    });
    expect(result.current).toEqual([]);

    const next = makeClaim("message-9");
    act(() => {
      claimFullscreen(next);
    });
    expect(result.current).toEqual(["message-9"]);
    act(() => {
      yieldFullscreen();
    });
    expect(result.current).toEqual([]);
  });

  it("pins nothing for a claim with no transcript row", () => {
    const { result } = renderHook(() => useFullscreenPinnedRowKeys());

    act(() => {
      claimFullscreen(makeClaim(null));
    });

    expect(result.current).toEqual([]);
  });
});
