import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/** Debounce covering typing bursts and ~50ms stream updates before promoting mermaid/wireframe codeBlocks. */
const IDLE_MS = 400;

interface PromotionTarget {
  readonly pos: number;
  readonly size: number;
  readonly language: "mermaid" | "wireframe";
  readonly text: string;
}

/** Collect mermaid/wireframe codeBlocks first; replacing inside descendants would shift later positions. */
function collectTargets(doc: PMNode): PromotionTarget[] {
  const out: PromotionTarget[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const lang = (node.attrs as { language?: string | null }).language ?? "";
    if (lang !== "mermaid" && lang !== "wireframe") return false;
    out.push({
      pos,
      size: node.nodeSize,
      language: lang,
      text: node.textContent,
    });
    // A code block has no block children worth walking - skip descent.
    return false;
  });
  return out;
}

/** Reverse-order replace so earlier positions stay valid. addToHistory=false so promotion does not pollute the Yjs undo stack. */
function promote(view: EditorView): void {
  const { schema } = view.state;
  // Both atom nodes must be registered. Missing them, create throws and the
  // outer try/catch swallows it.
  const mermaidType = schema.nodes.mermaidBlock;
  const wireframeType = schema.nodes.uiPreviewBlock;

  const targets = collectTargets(view.state.doc);
  if (targets.length === 0) return;

  let tr = view.state.tr;
  let changed = false;
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const target = targets[i];
    const nodeType =
      target.language === "mermaid" ? mermaidType : wireframeType;

    // Re-check at dispatch time: a concurrent remote update may have already
    // replaced this code block - in which case we silently skip rather than
    // stepping over a node of the wrong type.
    const existing = tr.doc.nodeAt(target.pos);
    if (existing === null || existing.type.name !== "codeBlock") continue;
    const existingLang =
      (existing.attrs as { language?: string | null }).language ?? "";
    if (existingLang !== target.language) continue;

    const attrs =
      target.language === "mermaid"
        ? { code: target.text }
        : { htmlContent: target.text, title: "UI Preview" };
    const replacement = nodeType.create(attrs);
    tr = tr.replaceWith(target.pos, target.pos + target.size, replacement);
    changed = true;
  }

  if (!changed) return;
  tr.setMeta("addToHistory", false);
  // Mark the transaction so nested plugins know this is the promotion step
  // and won't reschedule their own timers off it.
  tr.setMeta(fencePromotionPluginKey, { promoted: true });
  view.dispatch(tr);
}

export const fencePromotionPluginKey = new PluginKey<null>(
  "artifact-editor/fence-promotion",
);

/** Debounced scan promotes mermaid/wireframe codeBlocks to atoms. One path for parse, typing, streaming, and Yjs updates. */
export function fencePromotionPlugin(): Plugin {
  return new Plugin({
    key: fencePromotionPluginKey,
    view(view) {
      // Browser setTimeout returns number; Node Timeout typings break
      // inference. This plugin only runs in a DOM EditorView.
      let timer: number | null = null;

      const schedule = (): void => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          try {
            promote(view);
          } catch {
            // Swallow - a mid-flight schema mismatch (e.g. remote update
            // arrived between scan and dispatch) should not break the view.
          }
        }, IDLE_MS);
      };

      // Prime a scan for whatever the editor booted with (initial markdown
      // parse, snapshot hydration). Without this, a fragment that already
      // contains fences would only promote after the next transaction.
      schedule();

      return {
        update(v, prev): void {
          if (v.state.doc.eq(prev.doc)) return;
          // Don't reschedule off our own promotion transaction.
          const lastTr = v.state.tr; // not reliable source of prev meta
          // Always reschedule. The scan is cheap and idempotent once no
          // eligible codeBlocks remain.
          void lastTr;
          schedule();
        },
        destroy(): void {
          if (timer !== null) window.clearTimeout(timer);
          timer = null;
        },
      };
    },
  });
}
