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
  private booted = false;

  private ensureBoot(): void {
    if (this.booted) return;
    this.booted = true;

    void getOrCreateHighlighter()
      .then((highlighter) => {
        this.core = highlighter;
        return ensureActiveThemePair(highlighter);
      })
      .then(() => {
        this.notify();
      })
      .catch(() => {
        // Leave core null; consumers keep the plain <pre> fallback.
      });

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
