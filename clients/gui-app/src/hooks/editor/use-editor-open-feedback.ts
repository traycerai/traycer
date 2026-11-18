import { useCallback, useEffect, useRef, useState } from "react";

const EDITOR_OPEN_FEEDBACK_MS = 1000;

export function useEditorOpenFeedback() {
  const [active, setActive] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const trigger = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    setActive(true);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setActive(false);
    }, EDITOR_OPEN_FEEDBACK_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { active, trigger };
}
