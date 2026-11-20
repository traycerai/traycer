/**
 * A controllable IntersectionObserver and the window a person reads in, for
 * the cases that read a bot transcript: nothing is observed as seen until the
 * case says so. Holds no module state beyond `FakeIntersectionObserver.all`.
 */
import { act } from "@testing-library/react";
import { expect, onTestFinished, vi } from "vitest";

/** What an IntersectionObserver was built with, and what it watches. */
type ObserverOptions = { root: Element | null; rootMargin: string | undefined };
type ObserverEntries = ReadonlyArray<{
  target: Element;
  isIntersecting: boolean;
  boundingClientRect: DOMRect;
  intersectionRect: DOMRect;
}>;

/** A controllable IntersectionObserver: nothing fires until the case says so. */
export class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  readonly options: ObserverOptions;
  constructor(
    private readonly callback: (entries: ObserverEntries) => void,
    init: IntersectionObserverInit | undefined,
  ) {
    this.options = {
      root: init?.root instanceof Element ? init.root : null,
      rootMargin: init?.rootMargin,
    };
    FakeIntersectionObserver.all.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  fire(entries: ObserverEntries): void {
    this.callback(entries);
  }
}

/** The observers watching `target`: the near one has a margin, the view one none. */
export function observersOf(
  target: Element,
  kind: "near" | "view",
): FakeIntersectionObserver[] {
  return FakeIntersectionObserver.all.filter(
    (observer) =>
      observer.targets.has(target) &&
      (observer.options.rootMargin !== undefined) === (kind === "near"),
  );
}

/** Reports `target`, whole in view or out of it, to each of `observers`. */
function report(
  observers: readonly FakeIntersectionObserver[],
  target: Element,
  isIntersecting: boolean,
): void {
  for (const observer of observers) {
    // A row in view is whole in view, as a person looking at it sees it.
    const rect = new DOMRect(0, 0, 100, 100);
    target.getBoundingClientRect = () => rect;
    observer.fire([
      {
        target,
        isIntersecting,
        boundingClientRect: rect,
        intersectionRect: isIntersecting ? rect : new DOMRect(0, 0, 0, 0),
      },
    ]);
  }
}

/** Tells the observers of `kind` on `target` that it is (not) intersecting. */
export function intersectTarget(
  target: Element,
  kind: "near" | "view",
  isIntersecting: boolean,
): void {
  const observers = observersOf(target, kind);
  expect(observers.length).toBeGreaterThan(0);
  act(() => {
    report(observers, target, isIntersecting);
  });
}

/**
 * Reading needs a window the person is in; jsdom's own answer depends on which
 * cases ran before, so a case that reads says so itself.
 */
export function foregroundWindow(): void {
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  onTestFinished(() => hasFocus.mockRestore());
}

/** The drawn read row whose text holds `text`. */
export function drawnRowHolding(text: string): HTMLElement {
  const row = [...document.querySelectorAll("[data-bot-read-row]")].find(
    (candidate) => candidate.textContent.includes(text),
  );
  if (!(row instanceof HTMLElement)) throw new Error(`no read row for ${text}`);
  return row;
}

/**
 * The person looks at `row`: it is whole in view in a focused window for the
 * reading dwell. The dwell runs on a fake clock for this step only, so the
 * case's own waits keep real timers.
 */
export async function seeRow(row: Element): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    intersectTarget(row, "view", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_DWELL_MS);
    });
  } finally {
    vi.useRealTimers();
  }
}

/** The dwell the transcript's reading asks of a row in view. */
const READ_DWELL_MS = 1_000;

/**
 * The person looks at whatever the screen shows: every read row an observer
 * watches is whole in view for the reading dwell. Nothing drawn, nothing done.
 */
export async function seeEverythingDrawn(): Promise<void> {
  const watched = new Map<Element, FakeIntersectionObserver[]>();
  for (const observer of FakeIntersectionObserver.all) {
    if (observer.options.rootMargin !== undefined) continue;
    for (const target of observer.targets) {
      if (!target.hasAttribute("data-bot-read-row")) continue;
      watched.set(target, [...(watched.get(target) ?? []), observer]);
    }
  }
  if (watched.size === 0) return;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(() => {
      for (const [target, observers] of watched)
        report(observers, target, true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_DWELL_MS);
    });
  } finally {
    vi.useRealTimers();
  }
}
