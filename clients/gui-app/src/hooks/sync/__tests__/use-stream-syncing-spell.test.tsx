import "../../../../__tests__/test-browser-apis";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useStreamSyncingSpell } from "@/hooks/sync/use-stream-syncing-spell";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ReactNode } from "react";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface SpellInput {
  readonly status: StreamConnectionStatus;
  readonly hasContent: boolean;
  readonly identity: string;
}

function renderSpell(initial: SpellInput) {
  return renderHook((input: SpellInput) => useStreamSyncingSpell(input), {
    initialProps: initial,
  });
}

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.example/sign-in",
    authnBaseUrl: "https://auth.example",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/**
 * Counts the hook's live `onSystemResumed` subscriptions on `host`. The mock
 * keeps its handler set private, and a leaked subscriber is otherwise silent -
 * React no longer complains about a state write on an unmounted hook.
 */
function trackResumeSubscribers(host: MockRunnerHost): {
  readonly live: () => number;
} {
  let live = 0;
  const subscribe = host.onSystemResumed.bind(host);
  vi.spyOn(host, "onSystemResumed").mockImplementation((handler) => {
    live += 1;
    const subscription = subscribe(handler);
    return {
      dispose: () => {
        live -= 1;
        subscription.dispose();
      },
    };
  });
  return { live: () => live };
}

/** The spell under a shell that can report a system resume. */
function renderSpellWithShell(initial: SpellInput, host: MockRunnerHost) {
  return renderHook((input: SpellInput) => useStreamSyncingSpell(input), {
    initialProps: initial,
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <RunnerHostContext.Provider value={host}>
        {children}
      </RunnerHostContext.Provider>
    ),
  });
}

describe("useStreamSyncingSpell", () => {
  // The gate as a matrix rather than as a handful of examples: the contract is
  // "a surface with content on screen whose own stream is away", and every
  // other combination has to stay silent - including the two that look like
  // they should speak (a cold connect, a dead stream).
  const STATUSES: readonly StreamConnectionStatus[] = [
    "connecting",
    "open",
    "reconnecting",
    "closed",
  ];
  const SYNCING: ReadonlySet<StreamConnectionStatus> = new Set([
    "connecting",
    "reconnecting",
  ]);

  for (const status of STATUSES) {
    for (const hasContent of [true, false]) {
      const expected = hasContent && SYNCING.has(status);
      it(`syncing=${String(expected)} for status=${status} hasContent=${String(hasContent)}`, () => {
        const { result } = renderSpell({ status, hasContent, identity: "a" });
        expect(result.current.syncing).toBe(expected);
        expect(result.current.escalated).toBe(false);
      });
    }
  }

  it("escalates once the resync stops looking momentary", () => {
    vi.useFakeTimers();
    const { result } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
    });
    expect(result.current.escalated).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.escalated).toBe(true);
  });

  it("treats connecting and reconnecting as ONE outage, not two", () => {
    // A clock keyed on the raw status restarts on this flip and so never
    // escalates on a link that flaps between the two.
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "connecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    rerender({ status: "reconnecting", hasContent: true, identity: "a" });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    expect(result.current.escalated).toBe(true);
  });

  it("clears the escalated verdict the moment the stream is back", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.escalated).toBe(true);

    rerender({ status: "open", hasContent: true, identity: "a" });
    expect(result.current.syncing).toBe(false);
    expect(result.current.escalated).toBe(false);

    // A genuinely NEW outage starts unescalated rather than inheriting the
    // previous one's verdict.
    rerender({ status: "reconnecting", hasContent: true, identity: "a" });
    expect(result.current.escalated).toBe(false);
  });

  it("keeps timing an outage across a window in which nothing is drawn", () => {
    // The suppression case, at the level that decides it. The phone hides a
    // chat's strip while the Epic's is speaking, and the Epic's stream usually
    // returns first. If the clock lived in the hidden strip it would restart at
    // that hand-off, so a chat down since t=0 would say "Syncing…" - and start
    // animating again - a minute into its own outage. The hook is called
    // throughout, so what the caller drew is not part of the question.
    vi.useFakeTimers();
    const { result } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "chat-1",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.syncing).toBe(true);
    expect(result.current.escalated).toBe(true);
  });

  it("starts a new spell when the subject changes, escalated or not", () => {
    // Swipe from a chat whose resync has already escalated to one that has just
    // dropped. Without the identity the second chat inherits "Still syncing…"
    // and a stopped animation about an outage seconds old - the component is
    // reused, so no `key` on the strip would catch it either.
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "chat-1",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.escalated).toBe(true);

    rerender({ status: "reconnecting", hasContent: true, identity: "chat-2" });
    expect(result.current.syncing).toBe(true);
    expect(result.current.escalated).toBe(false);

    // And the NEW subject's clock runs its own full interval rather than
    // finishing the one it interrupted.
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
    });
    expect(result.current.escalated).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.escalated).toBe(true);
  });

  it("does not escalate a subject whose stream recovered before the interval", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderSpell({
      status: "reconnecting",
      hasContent: true,
      identity: "a",
    });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS / 2);
    });
    rerender({ status: "open", hasContent: true, identity: "a" });
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
    });
    expect(result.current.escalated).toBe(false);
  });

  describe("across a system resume", () => {
    // The clock measures how long a PERSON has waited, and a person who left
    // the app was not waiting. WKWebView freezes timers on suspension and, on
    // thaw, fires any whose deadline passed - measured on device at 25 ms
    // BEFORE the shell's resume signal reaches a subscriber. So the wait has to
    // restart at resume, and an escalation the thaw already fired has to be
    // taken back, not merely prevented.

    it("restarts the wait from the resume, not from when the stream dropped", () => {
      vi.useFakeTimers();
      const host = createRunnerHost();
      const { result } = renderSpellWithShell(
        { status: "reconnecting", hasContent: true, identity: "a" },
        host,
      );
      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS * 0.7);
      });
      act(() => {
        host.emitSystemResumed({ backgroundedForMs: 180_000 });
      });
      // 0.7 + 0.7 = 1.4 intervals since the drop, but only 0.7 since resume.
      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS * 0.7);
      });
      expect(result.current.escalated).toBe(false);
      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS * 0.3);
      });
      expect(result.current.escalated).toBe(true);
    });

    it("takes back an escalation the thaw fired before the resume signal arrived", () => {
      // The measured order: the 60 s deadline passes during suspension, the
      // timer fires as JS thaws, and ONLY THEN does `onSystemResumed` run.
      vi.useFakeTimers();
      const host = createRunnerHost();
      const { result } = renderSpellWithShell(
        { status: "reconnecting", hasContent: true, identity: "a" },
        host,
      );
      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
      });
      expect(result.current.escalated).toBe(true);

      act(() => {
        host.emitSystemResumed({ backgroundedForMs: 180_000 });
      });
      expect(result.current.escalated).toBe(false);

      // And the full interval runs again before it may escalate.
      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
      });
      expect(result.current.escalated).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.escalated).toBe(true);
    });

    it("takes back an escalation whose deadline passes after the resume but before React commits", () => {
      // The other order. The resume handler's state update waits for React's
      // scheduler, and an expired deadline can run in the gap - against a
      // record that already carries the new epoch. Both land in ONE act so
      // nothing is committed between them.
      vi.useFakeTimers();
      const host = createRunnerHost();
      const { result } = renderSpellWithShell(
        { status: "reconnecting", hasContent: true, identity: "a" },
        host,
      );
      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
      });
      act(() => {
        host.emitSystemResumed({ backgroundedForMs: 180_000 });
        vi.advanceTimersByTime(1);
      });
      expect(result.current.escalated).toBe(false);

      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS - 1);
      });
      expect(result.current.escalated).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.escalated).toBe(true);
    });

    it("gates on the signal, not on a measured dwell", () => {
      // Desktop's powerMonitor reports no sleep duration and sends `null`; a
      // laptop that slept mid-outage still was not being watched.
      vi.useFakeTimers();
      const host = createRunnerHost();
      const { result } = renderSpellWithShell(
        { status: "reconnecting", hasContent: true, identity: "a" },
        host,
      );
      act(() => {
        vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
      });
      expect(result.current.escalated).toBe(true);
      act(() => {
        host.emitSystemResumed({ backgroundedForMs: null });
      });
      expect(result.current.escalated).toBe(false);
    });

    it("does not listen while no spell is running", () => {
      vi.useFakeTimers();
      const host = createRunnerHost();
      const subscribers = trackResumeSubscribers(host);
      const { result } = renderSpellWithShell(
        { status: "open", hasContent: true, identity: "a" },
        host,
      );
      expect(subscribers.live()).toBe(0);
      act(() => {
        host.emitSystemResumed({ backgroundedForMs: 5_000 });
      });
      expect(result.current).toEqual({ syncing: false, escalated: false });
    });

    it("listens only for the life of the spell", () => {
      vi.useFakeTimers();
      const host = createRunnerHost();
      const subscribers = trackResumeSubscribers(host);
      const { rerender, unmount } = renderSpellWithShell(
        { status: "reconnecting", hasContent: true, identity: "a" },
        host,
      );
      expect(subscribers.live()).toBe(1);
      // The stream is back: nothing left to restart, so nothing to hear.
      rerender({ status: "open", hasContent: true, identity: "a" });
      expect(subscribers.live()).toBe(0);
      rerender({ status: "reconnecting", hasContent: true, identity: "a" });
      expect(subscribers.live()).toBe(1);
      unmount();
      expect(subscribers.live()).toBe(0);
    });
  });
});
