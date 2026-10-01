import { useEffect } from "react";
import "@/components/layout-editor/layout-editor.css";

/**
 * The canvas signal, shown rather than entered (L-50).
 *
 * The last step of the "Appearance and layout" guide points at the Customize
 * layout entry and, while it is up, dims the real chrome around Settings the
 * way a session does - so the person SEES what customizing looks like before
 * deciding to do it. Closing the step ends the effect and completes the guide;
 * nothing is entered, no lease is taken and nothing is written.
 *
 * A separate attribute from the session's `data-layout-editing`, and on the
 * document element rather than on the app column: this is a lit moment, not a
 * session, so it must not carry the session's other rules (the firewall's
 * `user-select: none`, the hover outline, the region attributes) and it must
 * not be something a session can be mistaken for. The stylesheet names both
 * attributes on the dim rules only.
 */
const LAYOUT_LIT_ATTRIBUTE = "data-layout-lit";

export function useLayoutLitMoment(lit: boolean): void {
  useEffect(() => {
    if (!lit) return;
    const root = document.documentElement;
    root.setAttribute(LAYOUT_LIT_ATTRIBUTE, "1");
    return () => {
      root.removeAttribute(LAYOUT_LIT_ATTRIBUTE);
    };
  }, [lit]);
}
