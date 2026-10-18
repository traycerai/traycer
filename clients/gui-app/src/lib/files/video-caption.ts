import { formatByteSize } from "@/lib/format-byte-size";

export interface VideoCaptionFacts {
  /** From the element's metadata; `null` until it loads. */
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  /** The file's size, from the files lane; `null` when it has not said. */
  readonly byteLength: number | null;
}

/** "1:42", or "1:02:09" past an hour: the clock a player shows, not "1m 42s". */
export function formatVideoDuration(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, "0");
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/**
 * The video control bar's caption (Viewers): "1:42 · 1920 × 1080 · 18 MiB".
 * Each part appears once it is known - the size first, the rest when the
 * element reports its metadata - so the bar never shows a placeholder.
 */
export function formatVideoCaption(facts: VideoCaptionFacts): string {
  const parts: string[] = [];
  // A live stream reports Infinity and a broken one NaN; neither is a length.
  if (
    facts.durationSeconds !== null &&
    Number.isFinite(facts.durationSeconds)
  ) {
    parts.push(formatVideoDuration(facts.durationSeconds));
  }
  if (facts.width !== null && facts.height !== null && facts.width > 0) {
    parts.push(`${facts.width} × ${facts.height}`);
  }
  if (facts.byteLength !== null) parts.push(formatByteSize(facts.byteLength));
  return parts.join(" · ");
}
