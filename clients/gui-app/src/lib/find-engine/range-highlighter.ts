interface SupportedHighlightsAPI {
  set(name: string, highlight: Highlight): void;
  delete(name: string): void;
}

export function getHighlights(): SupportedHighlightsAPI | null {
  if (typeof CSS === "undefined" || typeof Highlight === "undefined")
    return null;
  const registry = (CSS as { highlights: SupportedHighlightsAPI | undefined })
    .highlights;
  return registry ?? null;
}

let nextHighlightId = 1;

/** Owns only its ranges and styles, even when viewers share a document. */
export class RangeHighlighter {
  private readonly matchName: string;
  private readonly activeName: string;
  private styleElement: HTMLStyleElement | null = null;

  constructor() {
    const id = nextHighlightId++;
    this.matchName = `traycer-find-match-${id}`;
    this.activeName = `traycer-find-active-${id}`;
  }

  paint(
    root: HTMLElement,
    ranges: readonly Range[],
    activeIndex: number,
  ): void {
    const registry = getHighlights();
    if (registry === null) return;
    if (ranges.length === 0) {
      this.clear();
      return;
    }
    this.ensureStyle(root);
    const others = ranges.filter((_, index) => index !== activeIndex);
    if (others.length > 0) {
      registry.set(this.matchName, new Highlight(...others));
    } else {
      registry.delete(this.matchName);
    }
    const active = ranges.at(activeIndex);
    if (activeIndex >= 0 && active !== undefined) {
      registry.set(this.activeName, new Highlight(active));
    } else {
      registry.delete(this.activeName);
    }
  }

  clear(): void {
    const registry = getHighlights();
    registry?.delete(this.matchName);
    registry?.delete(this.activeName);
  }

  dispose(): void {
    this.clear();
    this.styleElement?.remove();
    this.styleElement = null;
  }

  private ensureStyle(root: HTMLElement): void {
    const tree = root.getRootNode();
    const styleRoot =
      tree instanceof ShadowRoot ? tree : root.ownerDocument.head;
    if (this.styleElement === null) {
      const style = root.ownerDocument.createElement("style");
      style.dataset.traycerFindHighlight = this.matchName;
      style.textContent = `
::highlight(${this.matchName}) {
  background-color: color-mix(in srgb, var(--primary) 35%, transparent);
  color: inherit;
}
::highlight(${this.activeName}) {
  background-color: color-mix(in srgb, var(--primary) 75%, transparent);
  color: var(--primary-foreground);
}`;
      this.styleElement = style;
    }
    if (this.styleElement.parentNode !== styleRoot)
      styleRoot.append(this.styleElement);
  }
}
