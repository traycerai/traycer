import {
  useCallback,
  useState,
  useSyncExternalStore,
  type RefCallback,
} from "react";

const EDITOR_SELECTOR = "[data-composer-editor]";

function editorIn(frame: HTMLDivElement | null): HTMLElement | null {
  return frame === null
    ? null
    : frame.querySelector<HTMLElement>(EDITOR_SELECTOR);
}

/**
 * Whether the editor inside the frame holds more than its capped box shows,
 * so it scrolls. Asked through the FRAME, which is the element the shell
 * owns; the editor itself arrives as a slot. Growth up to the cap moves the
 * editor's box (a resize); growth past it does not, so content changes are
 * watched too. `enabled` false keeps every observer off, for the desktop
 * composer, which has room to grow in place and never asks.
 */
export function useComposerEditorOverflow(enabled: boolean): {
  ref: RefCallback<HTMLDivElement>;
  overflows: boolean;
} {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((nextFrame: HTMLDivElement | null) => {
    setFrame((current) => (current === nextFrame ? current : nextFrame));
  }, []);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const editor = enabled ? editorIn(frame) : null;
      if (editor === null) return () => {};
      const resize = new ResizeObserver(onStoreChange);
      resize.observe(editor);
      const mutation = new MutationObserver(onStoreChange);
      mutation.observe(editor, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      return () => {
        resize.disconnect();
        mutation.disconnect();
      };
    },
    [enabled, frame],
  );
  const getSnapshot = useCallback(() => {
    const editor = enabled ? editorIn(frame) : null;
    return editor !== null && editor.scrollHeight > editor.clientHeight;
  }, [enabled, frame]);
  const getServerSnapshot = useCallback(() => false, []);

  return {
    ref,
    overflows: useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
  };
}
