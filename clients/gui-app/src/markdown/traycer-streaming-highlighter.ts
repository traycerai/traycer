import type { HighlightOutput, StreamingHighlighter } from "@tailmark/react";
import type { ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";
import { trustedMarkupToReactNodes } from "@/lib/trusted-markup";
import { contentFingerprint } from "@/lib/text-hash";
import { subscribeResolvedTheme } from "@/lib/theme-applier";
import {
  getCachedHighlight,
  estimatedHighlightBytes,
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

interface DeferredHighlight {
  readonly blockKey: string;
  output: HighlightOutput | null;
  finished: boolean;
  cancel: () => void;
}

const DEFERRED_HIGHLIGHT_BYTE_BUDGET = 8 * 1024 * 1024;

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
  private readonly consumers = new Map<string, number>();
  // Short-lived handoff to Tailmark, which alone decides when a block is settled.
  private readonly deferred = new Map<string, DeferredHighlight>();

  private clearDeferred(): void {
    for (const entry of this.deferred.values()) entry.cancel();
    this.deferred.clear();
  }

  private trimDeferred(): void {
    const finished = Array.from(this.deferred).filter(
      ([, entry]) => entry.finished,
    );
    let bytes = finished.reduce(
      (total, [, entry]) =>
        total + estimatedHighlightBytes(entry.output?.weight ?? 0),
      0,
    );
    // Never cancel queued work to admit another block: a page with more than
    // 32 cold blocks must still make progress. Keep one oversized output long
    // enough for Tailmark to consume it rather than endlessly retrying it.
    let remaining = finished.length;
    for (const [key, entry] of finished) {
      if (
        remaining <= 32 &&
        (bytes <= DEFERRED_HIGHLIGHT_BYTE_BUDGET || remaining === 1)
      )
        break;
      bytes -= estimatedHighlightBytes(entry.output?.weight ?? 0);
      remaining -= 1;
      this.deferred.delete(key);
    }
  }

  private readonly listeners = new Set<ReadyListener>();
  private unsubscribeTheme: (() => void) | null = null;
  /** One-time palette observer - not cleared on core load failure. */
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

    this.unsubscribeTheme = subscribeResolvedTheme(() => {
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
    this.clearDeferred();
    this.consumers.clear();
    this.core = null;
    this.coreLoad = null;
    this.listeners.clear();
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    this.observersAttached = false;
  }

  private onThemeSurfaceChange(): void {
    this.clearDeferred();
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

    const render = (): HighlightOutput | null => {
      const html = highlightCode(core, code, lang, theme);
      if (html === null) return null;
      return {
        node: trustedMarkupToReactNodes(html, "html"),
        weight: html.length,
      };
    };
    // Small blocks keep the existing synchronous path. A cold large block
    // paints its same-sized plain <pre> before tokenization and markup parsing.
    if (code.length < 4096) return render();
    const blockKey = `${lang}\0${contentFingerprint(code)}`;
    const key = `${theme}\0${blockKey}`;
    const existing = this.deferred.get(key);
    if (existing !== undefined) return existing.output;
    if (!this.consumers.has(blockKey)) return null;
    const entry: DeferredHighlight = {
      blockKey,
      output: null,
      finished: false,
      cancel: () => {},
    };
    const run = (): void => {
      if (this.deferred.get(key) !== entry) return;
      if (!this.consumers.has(blockKey)) {
        this.deferred.delete(key);
        return;
      }
      try {
        entry.output = render();
      } catch {
        // Keep the plain-text fallback if markup conversion fails.
        entry.output = null;
      }
      entry.finished = true;
      this.trimDeferred();
      this.notify();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 500 });
      entry.cancel = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(run, 0);
      entry.cancel = () => window.clearTimeout(id);
    }
    this.deferred.set(key, entry);
    return null;
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
    this.deferred.delete(`${theme}\0${lang}\0${contentFingerprint(code)}`);
    setCachedHighlight(theme, lang, code, {
      node: output.node,
      htmlChars: output.weight,
    });
  }

  subscribeBlock(
    code: string,
    lang: string,
    onReadyChange: () => void,
  ): () => void {
    const blockKey = `${lang}\0${contentFingerprint(code)}`;
    this.consumers.set(blockKey, (this.consumers.get(blockKey) ?? 0) + 1);
    const unsubscribe = this.subscribe(onReadyChange);
    // Retry through Tailmark after ownership commits. Calling highlight here
    // would bypass its streaming throttle whenever the source changes.
    if (code.length >= 4096 && this.getCached(code, lang) === null) {
      onReadyChange();
    }
    return () => {
      unsubscribe();
      const remaining = (this.consumers.get(blockKey) ?? 1) - 1;
      if (remaining > 0) {
        this.consumers.set(blockKey, remaining);
        return;
      }
      this.consumers.delete(blockKey);
      for (const [key, entry] of this.deferred) {
        if (entry.blockKey !== blockKey || entry.finished) continue;
        entry.cancel();
        this.deferred.delete(key);
      }
    };
  }

  subscribe(onReadyChange: () => void): () => void {
    this.ensureBoot();
    this.listeners.add(onReadyChange);
    return () => {
      this.listeners.delete(onReadyChange);
      // Keep palette subscription for the process lifetime: other
      // CodeBlock instances still need it. Only detach when empty would
      // thrash observers under list virtualization; leave it on.
      void this.unsubscribeTheme;
    };
  }
}

const traycerStreamingHighlighter = new TraycerStreamingHighlighter();

/** Shared core/readiness access; deferred jobs need a block-owned adapter. */
export function getTraycerStreamingHighlighter(): StreamingHighlighter {
  return traycerStreamingHighlighter;
}

/** Tailmark's subscription is the lifetime of one mounted code block. */
export function createTraycerBlockHighlighter(
  code: string,
  lang: string,
): StreamingHighlighter {
  return {
    highlight: () => traycerStreamingHighlighter.highlight(code, lang),
    getCached: () => traycerStreamingHighlighter.getCached(code, lang),
    setCached: (_code, _lang, output) =>
      traycerStreamingHighlighter.setCached(code, lang, output),
    subscribe: (onReadyChange) =>
      traycerStreamingHighlighter.subscribeBlock(code, lang, onReadyChange),
  };
}

/** Drop singleton readiness state between tests that mock the Shiki boot path. */
export function resetTraycerStreamingHighlighterForTests(): void {
  traycerStreamingHighlighter.resetForTests();
}
