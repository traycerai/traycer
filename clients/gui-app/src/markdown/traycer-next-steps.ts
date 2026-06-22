const TRAYCER_NEXT_STEPS_OPEN_TAG = "<TRAYCER_NEXT_STEPS>";
const TRAYCER_NEXT_STEPS_CLOSE_TAG = "</TRAYCER_NEXT_STEPS>";

export interface TraycerNextStepOption {
  readonly id: string;
  readonly prompt: string;
}

export type TraycerNextStepsPart =
  | {
      readonly kind: "markdown";
      readonly id: string;
      readonly markdown: string;
    }
  | {
      readonly kind: "next_steps";
      readonly id: string;
      readonly prose: string;
      readonly options: ReadonlyArray<TraycerNextStepOption>;
      readonly complete: boolean;
    };

interface LineInfo {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly endWithNewline: number;
}

interface ExtractedBlock {
  readonly start: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly complete: boolean;
}

const CLOSE_LINE_PATTERN = /^[\t ]*<\/TRAYCER_NEXT_STEPS>[\t ]*$/;
const OPEN_AT_LINE_START_PATTERN = /^[\t ]*<TRAYCER_NEXT_STEPS>[\t ]*/;
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})/;
const NEXT_STEP_OPTION_PATTERN =
  /^[\t ]*-[\t ]*\[[\t ]*\][\t ]*:?\s*([\s\S]*?)[\t ]*$/;
const MAX_COMPLETED_PARSE_CACHE_ENTRIES = 50;
const MAX_COMPLETED_PARSE_CACHE_CHARS = 500_000;

const completedParseCache = new Map<
  string,
  ReadonlyArray<TraycerNextStepsPart>
>();

export function parseTraycerNextStepsMarkdown(
  markdown: string,
  isStreaming: boolean,
): ReadonlyArray<TraycerNextStepsPart> {
  if (!markdown.includes(TRAYCER_NEXT_STEPS_OPEN_TAG)) {
    return [
      {
        kind: "markdown",
        id: "markdown:0",
        markdown,
      },
    ];
  }

  if (!isStreaming && markdown.length <= MAX_COMPLETED_PARSE_CACHE_CHARS) {
    const cached = completedParseCache.get(markdown);
    if (cached !== undefined) {
      completedParseCache.delete(markdown);
      completedParseCache.set(markdown, cached);
      return cached;
    }
    const parsed = parseTraycerNextStepsMarkdownWithTags(markdown, false);
    completedParseCache.set(markdown, parsed);
    trimCompletedParseCache();
    return parsed;
  }

  return parseTraycerNextStepsMarkdownWithTags(markdown, isStreaming);
}

function parseTraycerNextStepsMarkdownWithTags(
  markdown: string,
  isStreaming: boolean,
): ReadonlyArray<TraycerNextStepsPart> {
  const blocks = extractNextStepsBlocks(markdown, isStreaming);
  if (blocks.length === 0) {
    return [
      {
        kind: "markdown",
        id: "markdown:0",
        markdown,
      },
    ];
  }

  const parts: TraycerNextStepsPart[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.start > cursor) {
      pushMarkdownPart(parts, markdown.slice(cursor, block.start));
    }
    const blockContent = markdown.slice(block.contentStart, block.contentEnd);
    const parsed = parseNextStepsBlock(blockContent);
    if (parsed === null) {
      pushMarkdownPart(parts, stripBoundaryBlankLines(blockContent));
    } else {
      parts.push({
        kind: "next_steps",
        // Keyed on the open-tag offset only: it is unique per block and frozen
        // the moment the tag arrives. `block.end` must stay out of the id - for
        // an incomplete streaming block it is `markdown.length`, which grows
        // every frame and would remount the part (prose markdown + action
        // buttons) on every streamed token.
        id: `next:${block.start}`,
        prose: parsed.prose,
        options: parsed.options,
        complete: block.complete,
      });
    }
    cursor = block.end;
  }
  if (cursor < markdown.length) {
    pushMarkdownPart(parts, markdown.slice(cursor));
  }
  return parts.length === 0
    ? [{ kind: "markdown", id: "markdown:0", markdown: "" }]
    : parts;
}

export function repairTraycerNextStepsMarkdown(markdown: string): string {
  if (!markdown.includes(TRAYCER_NEXT_STEPS_OPEN_TAG)) return markdown;
  const blocks = extractNextStepsBlocks(markdown, true);
  if (blocks.length === 0) return markdown;
  const last = blocks.at(-1);
  if (last === undefined || last.complete) return markdown;
  return `${markdown.trimEnd()}\n${TRAYCER_NEXT_STEPS_CLOSE_TAG}`;
}

function trimCompletedParseCache(): void {
  while (completedParseCache.size > MAX_COMPLETED_PARSE_CACHE_ENTRIES) {
    const oldestKey = completedParseCache.keys().next().value;
    if (oldestKey === undefined) return;
    completedParseCache.delete(oldestKey);
  }
}

function pushMarkdownPart(
  parts: TraycerNextStepsPart[],
  markdown: string,
): void {
  if (markdown.length === 0) return;
  parts.push({
    kind: "markdown",
    id: `markdown:${parts.length}`,
    markdown,
  });
}

function extractNextStepsBlocks(
  markdown: string,
  isStreaming: boolean,
): ReadonlyArray<ExtractedBlock> {
  const lines = splitLines(markdown);
  const blocks: ExtractedBlock[] = [];
  let fence: string | null = null;
  let openStart: number | null = null;
  let contentStart: number | null = null;

  for (const line of lines) {
    const nextFence = nextFenceState(fence, line.text);
    const open = openTagLine(line);
    if (fence === null && openStart === null && open !== null) {
      openStart = line.start;
      contentStart = open.contentStart;
      fence = nextFence;
      continue;
    }

    if (
      fence === null &&
      openStart !== null &&
      CLOSE_LINE_PATTERN.test(line.text)
    ) {
      blocks.push({
        start: openStart,
        contentStart: contentStart ?? line.start,
        contentEnd: line.start,
        end: line.endWithNewline,
        complete: true,
      });
      openStart = null;
      contentStart = null;
      fence = nextFence;
      continue;
    }

    fence = nextFence;
  }

  if (openStart !== null && !isStreaming) {
    blocks.push({
      start: openStart,
      contentStart: contentStart ?? markdown.length,
      contentEnd: markdown.length,
      end: markdown.length,
      complete: true,
    });
  } else if (openStart !== null) {
    blocks.push({
      start: openStart,
      contentStart: contentStart ?? markdown.length,
      contentEnd: markdown.length,
      end: markdown.length,
      complete: false,
    });
  }

  return blocks;
}

function openTagLine(line: LineInfo): { readonly contentStart: number } | null {
  const match = OPEN_AT_LINE_START_PATTERN.exec(line.text);
  if (match === null) return null;
  const contentStartOffset = match[0].length;
  return {
    contentStart:
      contentStartOffset >= line.text.length
        ? line.endWithNewline
        : line.start + contentStartOffset,
  };
}

function splitLines(text: string): ReadonlyArray<LineInfo> {
  const lines: LineInfo[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const endWithNewline = newline < 0 ? text.length : newline + 1;
    const end = newline < 0 ? text.length : newline;
    const lineText =
      end > start && text.charCodeAt(end - 1) === 13
        ? text.slice(start, end - 1)
        : text.slice(start, end);
    lines.push({ text: lineText, start, end, endWithNewline });
    start = endWithNewline;
  }
  if (text.length === 0) {
    lines.push({ text: "", start: 0, end: 0, endWithNewline: 0 });
  }
  return lines;
}

function nextFenceState(fence: string | null, line: string): string | null {
  const match = line.match(FENCE_PATTERN);
  if (match === null) return fence;
  const marker = match[2];
  if (fence === null) {
    return marker.charAt(0).repeat(marker.length);
  }
  const fenceChar = fence.charAt(0);
  if (marker.charAt(0) !== fenceChar || marker.length < fence.length) {
    return fence;
  }
  return null;
}

function parseNextStepsBlock(content: string): {
  readonly prose: string;
  readonly options: ReadonlyArray<TraycerNextStepOption>;
} | null {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let cursor = lines.length - 1;
  while (cursor >= 0 && lines[cursor].trim().length === 0) {
    cursor -= 1;
  }

  const options: TraycerNextStepOption[] = [];
  let foundOption = false;
  while (cursor >= 0) {
    const line = lines[cursor];
    if (line.trim().length === 0) {
      if (!foundOption) break;
      cursor -= 1;
      continue;
    }
    const option = parseNextStepOptionLine(line, cursor);
    if (option === null) break;
    options.unshift(option);
    foundOption = true;
    cursor -= 1;
  }

  if (options.length === 0) return null;

  return {
    prose: stripBoundaryBlankLines(lines.slice(0, cursor + 1).join("\n")),
    options,
  };
}

function parseNextStepOptionLine(
  line: string,
  lineIndex: number,
): TraycerNextStepOption | null {
  const match = NEXT_STEP_OPTION_PATTERN.exec(line);
  if (match === null) return null;
  const prompt = match[1].trim();
  if (prompt.length === 0) return null;
  return {
    // Line index alone is unique within a block and stable while the trailing
    // option's prompt is still streaming in (its length is not).
    id: `option:${lineIndex}`,
    prompt,
  };
}

function stripBoundaryBlankLines(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim().length === 0) {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end).join("\n");
}
