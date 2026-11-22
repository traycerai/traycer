import { useCallback, useEffect, useRef } from "react";

/** A submitted snapshot is consumed once; the form's draft has its own lifetime. */
export function useSubmittedSecretInput<Value>(unavailableMessage: string) {
  const input = useRef<{ readonly value: Value } | null>(null);
  const set = useCallback((value: Value): void => {
    input.current = { value };
  }, []);
  const clear = useCallback((): void => {
    input.current = null;
  }, []);
  const read = useCallback((): Value => {
    const submitted = input.current;
    input.current = null;
    if (submitted === null) throw new Error(unavailableMessage);
    return submitted.value;
  }, [unavailableMessage]);
  useEffect(() => clear, [clear]);
  return { set, read, clear };
}
