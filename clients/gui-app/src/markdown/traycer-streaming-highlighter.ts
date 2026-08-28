import type { HighlightOutput, StreamingHighlighter } from "@tailmark/react";
import type { ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  getCachedHighlight,
  setCachedHighlight,
} from "./shiki-highlight-cache";
import {
  ensureActiveThemePair,
  getOrCreateHighlighter,
  highlightCode,
  MAX_HIGHLIGHT_CHARS,
  resolveActiveShikiTheme,
} from "./shiki-highlighter";

type ReadyListener = () => void;

/**
 * Theme-aware StreamingHighlighter over Traycer's multi-preset Shiki core and
 * byte-budgeted MRU cache. Tailmark's cache key is (code, lang); theme is
 * resolved live so light/dark and preset swaps stay correct.
 *
 * Module singleton: one readiness bus and one engine for every markdown and
 * workspace surface.
 */
class TraycerStreamingHighlighter implements StreamingHighlighter {
  private core: HighlighterCore | null = null;
  private readonly listeners = new Set<ReadyListener>();
  private unsubDoc: (() => void) | null = null;
  private unsubPreset: (() => void) | null = null;
  /** One-time document/preset observers - not cleared on core load failure. */
  private observersAttached = false;
  /**
   * In-flight core load. Cleared on rejection so a later `highlight` /
   * `subscribe` can retry after a transient chunk or theme failure. Successful
   * loads leave the promise settled with `core` set.
   */
  private coreLoad: Promise<void> | null = null;

  private ensureBoot(): void {
    this.attachObserversOnce();
    void this.ensureCore();
  }

  private attachObserversOnce(): void {
    if (this.observersAttached) return;
    this.observersAttached = true;

    if (typeof document !== "undefined") {
      const observer = new MutationObserver(() => {
        this.onThemeSurfaceChange();
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      this.unsubDoc = () => {
        observer.disconnect();
      };
    }

    this.unsubPreset = useSettingsStore.subscribe((state, prev) => {
      if (state.themePreset === prev.themePreset) return;
      this.onThemeSurfaceChange();
    });
  }

  private ensureCore(): Promise<void> {
    if (this.core !== null) return Promise.resolve();
    if (this.coreLoad !== null) return this.coreLoad;

    this.coreLoad = getOrCreateHighlighter()
      .then(async (highlighter) => {
        await ensureActiveThemePair(highlighter);
        this.core = highlighter;
        this.notify();
      })
      .catch(() => {
        // Leave core null for plain <pre> fallback, and clear the latch so a
        // later call can retry (transient import / theme load failures).
        this.core = null;
        this.coreLoad = null;
      });

    return this.coreLoad;
  }

  /** Test-only: drop core and observers so suites can re-boot cleanly. */
  resetForTests(): void {
    this.core = null;
    this.coreLoad = null;
    this.listeners.clear();
    this.unsubDoc?.();
    this.unsubPreset?.();
    this.unsubDoc = null;
    this.unsubPreset = null;
    this.observersAttached = false;
  }

  private onThemeSurfaceChange(): void {
    const core = this.core;
    if (core !== null) {
      void ensureActiveThemePair(core)
        .then(() => {
          this.notify();
        })
        .catch(() => {
          this.notify();
        });
      return;
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  highlight(code: string, lang: string): HighlightOutput | null {
    this.ensureBoot();
    if (lang.length === 0) return null;
    if (code.length > MAX_HIGHLIGHT_CHARS) return null;
    const core = this.core;
    if (core === null) return null;

    const theme = resolveActiveShikiTheme();
    if (!core.getLoadedThemes().includes(theme)) {
      void ensureActiveThemePair(core)
        .then(() => {
          this.notify();
        })
        .catch(() => {});
      return null;
    }

    const html = highlightCode(core, code, lang, theme);
    if (html === null) return null;
    return {
      node: trustedMarkupToReactNodes(html, "html"),
      weight: html.length,
    };
  }

  getCached(code: string, lang: string): ReactNode | null {
    this.ensureBoot();
    if (lang.length === 0) return null;
    const theme = resolveActiveShikiTheme();
    return getCachedHighlight(theme, lang, code) ?? null;
  }

  setCached(code: string, lang: string, output: HighlightOutput): void {
    this.ensureBoot();
    if (lang.length === 0) return;
    const theme = resolveActiveShikiTheme();
    setCachedHighlight(theme, lang, code, {
      node: output.node,
      htmlChars: output.weight,
    });
  }

  subscribe(onReadyChange: () => void): () => void {
    this.ensureBoot();
    this.listeners.add(onReadyChange);
    return () => {
      this.listeners.delete(onReadyChange);
      // Keep document/preset subscriptions for the process lifetime: other
      // CodeBlock instances still need them. Only detach when empty would
      // thrash observers under list virtualization; leave them on.
      void this.unsubDoc;
      void this.unsubPreset;
    };
  }
}

const traycerStreamingHighlighter = new TraycerStreamingHighlighter();

/** Shared adapter for StreamingMarkdown and product CodeBlock chrome. */
export function getTraycerStreamingHighlighter(): StreamingHighlighter {
  return traycerStreamingHighlighter;
}

/** Drop singleton readiness state between tests that mock the Shiki boot path. */
export function resetTraycerStreamingHighlighterForTests(): void {
  traycerStreamingHighlighter.resetForTests();
}
