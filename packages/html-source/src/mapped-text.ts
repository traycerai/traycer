import { decodeAttribute, decodeText } from "./parse";
import type { SourceRange } from "./types";

export interface MappedText {
  value: string;
  /** Each decoded UTF-16 unit points to the source characters that produced it. */
  ranges: SourceRange[];
}

/** Decode while retaining entity and CRLF boundaries. No DOM or Node APIs. */
export function decodeMapped(
  raw: string,
  offset: number,
  context: "text" | "attribute",
): MappedText {
  const result: MappedText = { value: "", ranges: [] };
  const chunks: string[] = [];
  const cache = new Map<string, string>();
  const append = (value: string, start: number, end: number) => {
    chunks.push(value);
    for (let index = 0; index < value.length; index++)
      result.ranges.push({ start: offset + start, end: offset + end });
  };
  for (let index = 0; index < raw.length;) {
    if (raw[index] === "&") {
      const candidate =
        /^&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[a-zA-Z][a-zA-Z0-9]*;?)/.exec(
          raw.slice(index),
        )?.[0];
      if (candidate) {
        // '=' suppresses a semicolon-less named reference in attribute context.
        const suffix =
          context === "attribute" && raw[index + candidate.length] === "="
            ? "="
            : "";
        const input = candidate + suffix;
        let decoded = cache.get(input);
        if (decoded === undefined) {
          decoded =
            context === "attribute"
              ? decodeAttribute(input)
              : decodeText(input);
          cache.set(input, decoded);
        }
        if (suffix) decoded = decoded.slice(0, -1);
        if (decoded !== candidate) {
          // Legacy references can consume a prefix: &notit; decodes to ¬it;.
          let trailing = 0;
          while (
            trailing < decoded.length - 1 &&
            trailing < candidate.length &&
            decoded[decoded.length - trailing - 1] ===
              candidate[candidate.length - trailing - 1]
          )
            trailing++;
          const consumed = candidate.length - trailing;
          append(
            decoded.slice(0, decoded.length - trailing),
            index,
            index + consumed,
          );
          index += consumed;
          continue;
        }
      }
    }
    const char = raw[index];
    const width = char === "\r" && raw[index + 1] === "\n" ? 2 : 1;
    append(
      char === "\r" ? "\n" : char === "\0" ? "\ufffd" : (char ?? ""),
      index,
      index + width,
    );
    index += width;
  }
  result.value = chunks.join("");
  return result;
}

export function mappedRange(
  mapped: MappedText,
  start: number,
  end: number,
  emptyAt: number,
): SourceRange {
  return {
    start: mapped.ranges[start]?.start ?? emptyAt,
    end:
      end > start
        ? (mapped.ranges[end - 1]?.end ?? emptyAt)
        : (mapped.ranges[start]?.start ?? emptyAt),
  };
}

export function normalizeWhitespace(mapped: MappedText): MappedText {
  const chunks: string[] = [];
  const ranges: SourceRange[] = [];
  for (let index = 0; index < mapped.value.length; index++) {
    const char = mapped.value.charAt(index);
    const range = mapped.ranges[index];
    if (!range) continue;
    if (/\s/u.test(char)) {
      const previous = ranges[ranges.length - 1];
      if (chunks[chunks.length - 1] === " " && previous)
        previous.end = range.end;
      else {
        chunks.push(" ");
        ranges.push({ ...range });
      }
    } else {
      chunks.push(char);
      ranges.push({ ...range });
    }
  }
  return { value: chunks.join(""), ranges };
}
