import { useState } from "react";

/**
 * `value`, kept by identity for as long as `same` says it has not changed.
 *
 * For a value re-derived on every render whose consumers memoize on its
 * identity: a chat tile re-renders once per streamed flush, so a list rebuilt
 * from the transcript gets a new identity about thirty times a second and
 * re-renders every row downstream of it, whether or not anything in it moved.
 *
 * The carry is `useState`, not `useRef`. React may discard a render, and a ref
 * written by a discarded render is not rolled back; `setState` during render
 * is the sanctioned form of the same carry (see `useStableFallbackNotices` in
 * `chat-messages.tsx`). The render that sets it returns `value`, which is what
 * the re-render it schedules returns too.
 */
export function useStableValue<T>(
  value: T,
  same: (held: T, next: T) => boolean,
): T {
  const [held, setHeld] = useState(value);
  if (held === value || same(held, value)) return held;
  setHeld(value);
  return value;
}
