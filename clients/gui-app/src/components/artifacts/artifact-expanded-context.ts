import {
  createContext,
  useContext,
  useEffectEvent,
  useLayoutEffect,
  type RefObject,
} from "react";

type EscapeHandler = (event: KeyboardEvent) => boolean;
export const ArtifactExpandedContext =
  createContext<RefObject<EscapeHandler | null> | null>(null);

export function useArtifactExpanded(): boolean {
  return useContext(ArtifactExpandedContext) !== null;
}

/** Local canvas modes get the first Escape, before the dialog's capture listener closes it. */
export function useArtifactEscape(handler: EscapeHandler): void {
  const ownerRef = useContext(ArtifactExpandedContext);
  const handleEscape = useEffectEvent(handler);
  useLayoutEffect(() => {
    if (ownerRef === null) return;
    ownerRef.current = (event) => handleEscape(event);
    return () => {
      ownerRef.current = null;
    };
  }, [ownerRef]);
}
