import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Idle-window after which a `codeBlock` with language `mermaid` / `wireframe`
 * is promoted to its rich atom node. Chosen as a conservative debounce that
 * (a) ignores active typing bursts, (b) ignores the high-frequency updates
 * AI streaming produces (~50ms cadence), and (c) still feels responsive
 * after the stream / typist pauses.
 */
const IDLE_MS = 400;

interface PromotionTarget {
  readonly pos: number;
  readonly size: number;
  readonly language: "mermaid" | "wireframe";
  readonly text: string;
}

/**
 * Scans the current doc for `codeBlock` nodes whose language matches one of
 * the supported rich-block languages and returns them as replacement targets.
 * We collect first, dispatch second: positions would shift mid-walk if we
 * replaced inside `descendants`.
 */
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

/**
 * Replaces each eligible `codeBlock` with its rich atom counterpart. Runs in
 * reverse document order so earlier positions stay valid as later slices
 * shrink the doc. Dispatches a single transaction with `addToHistory=false`
 * so the promotion does not pollute the Yjs undo stack (users should
 * undo/redo text edits, not this structural shuffle).
 */
function promote(view: EditorView): void {
  const { schema } = view.state;
  // Both rich atom nodes must be registered - the plugin is installed by
  // `buildArtifactExtensions` alongside them, so this is always true at
  // runtime. If a future caller wires the plugin in without the nodes the
  // first `create` below will throw and the outer try/catch swallows it.
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

/**
 * ProseMirror plugin that watches for `codeBlock(language=mermaid|wireframe)`
 * nodes and, after an idle window, swaps each into the corresponding rich
 * atom node (`mermaidBlock` / `uiPreviewBlock`). The plugin is the single
 * source of truth for promotion - initial markdown parse, user typing, AI
 * streaming, and remote Yjs updates all flow through the same debounced
 * scan, so there is no bespoke path per source.
 */
export function fencePromotionPlugin(): Plugin {
  return new Plugin({
    key: fencePromotionPluginKey,
    view(view) {
      // Browser `setTimeout` returns `number`; the node typings pick
      // up `Timeout` which breaks cross-platform type inference. Stick
      // to the explicit browser type here - this plugin only runs in a
      // DOM EditorView.
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
          // Meta is on the transactions that produced this update - we can
          // approximate by checking if the doc shape change was a
          // codeBlock→atom swap. Simpler: always reschedule; the scan is
          // cheap and idempotent once no eligible code blocks remain.
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
