/**
 * An `IntersectionObserver` for suites whose cards are all on screen: it
 * reports every observed element as intersecting the moment it is observed,
 * which is how a card in view looks to the code that observes it. jsdom has no
 * observer of its own.
 */
export class AlwaysIntersectingObserver {
  constructor(
    private readonly callback: (
      entries: Array<{ target: Element; isIntersecting: boolean }>,
    ) => void,
  ) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }]);
  }
  unobserve(): void {}
  disconnect(): void {}
}
