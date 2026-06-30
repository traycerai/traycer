type RefLike<T> =
  ((value: T | null) => void) | { current: T | null } | null | undefined;

export function mergeRefs<T>(
  ...refs: ReadonlyArray<RefLike<T>>
): (value: T | null) => void {
  return (value) => {
    for (const ref of refs) {
      if (ref === null || ref === undefined) continue;
      if (typeof ref === "function") {
        ref(value);
        continue;
      }
      ref.current = value;
    }
  };
}
