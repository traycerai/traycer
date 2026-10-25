/**
 * The name Traycer gives a Claude Code session it starts on the Terminal
 * interface (`claude --name`), rendered from a user template once, at the
 * launch that creates the session. A resume never renames, and Traycer never
 * writes the name back later: a user's own `/rename` stands.
 *
 * Shared by the host, which renders the name at launch, and the Settings
 * field, which validates a template and previews it, so the two cannot
 * disagree about what a template means.
 */

/**
 * Every placeholder a template may use. `task` and `agent` are the titles as
 * they stand when the session starts: a brand-new Task is titled from its
 * first prompt, after Claude has started, so both are empty there.
 */
export const SESSION_NAME_PLACEHOLDERS = [
  "project",
  "repository",
  "branch",
  "task",
  "agent",
  "agent_id",
  "date",
  "time",
] as const;
type SessionNamePlaceholder = (typeof SESSION_NAME_PLACEHOLDERS)[number];

export type SessionNameValues = Readonly<
  Record<SessionNamePlaceholder, string>
>;

export const DEFAULT_CLAUDE_SESSION_NAME_TEMPLATE =
  "Traycer · {project} · {date}";

/** Longest template the config block and the set request accept. */
export const SESSION_NAME_TEMPLATE_MAX_LENGTH = 200;

/** Longest rendered name, in code points. */
const SESSION_NAME_MAX_LENGTH = 100;

const PLACEHOLDER_PATTERN = /\{([A-Za-z_]+)\}/g;
const LEADING_SEPARATORS = /^[\s\u00b7\-_/]+/u;
const TRAILING_SEPARATORS = /[\s\u00b7\-_/]+$/u;
const EDGE_SEPARATORS = /^[\s\u00b7\-_/]+|[\s\u00b7\-_/]+$/gu;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
// The bidi controls: the embeddings and overrides (U+202A..U+202E), the
// isolates (U+2066..U+2069) and the invisible direction marks (U+200E,
// U+200F, U+061C). Each changes how the text after it is ordered, so a title
// could make a name display as something it does not say. Every other format
// character stays: ZWJ joins an emoji sequence, ZWNJ is spelling in Persian.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu;

function isPlaceholder(name: string): name is SessionNamePlaceholder {
  return (SESSION_NAME_PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * The `{name}`s in a template that are not in `known`, each once. `known` is
 * the reader's own list: the host checks against `SESSION_NAME_PLACEHOLDERS`,
 * the Settings field against the list the host reported.
 */
export function unknownSessionNamePlaceholders(
  template: string,
  known: readonly string[],
): readonly string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !known.includes(name)) unknown.add(name);
  }
  return [...unknown];
}

/** `date` and `time` for `now`, in the machine's local time zone. */
export function sessionNameClockValues(now: Date): {
  readonly date: string;
  readonly time: string;
} {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}-${pad(now.getMinutes())}`,
  };
}

/**
 * Renders a template. An empty value drops its placeholder together with the
 * separators it leaves doubled, so `Traycer · {project} · {date}` for an agent
 * with no folder reads `Traycer · 2026-10-24`. An unknown `{name}` stays as
 * written. A result that comes out empty renders the default template, which
 * always keeps its `Traycer`.
 */
export function renderSessionName(
  template: string,
  values: SessionNameValues,
): string {
  const rendered = renderOnce(template, values);
  return rendered === ""
    ? renderOnce(DEFAULT_CLAUDE_SESSION_NAME_TEMPLATE, values)
    : rendered;
}

function renderOnce(template: string, values: SessionNameValues): string {
  let out = "";
  // Set by an empty value: the next literal's leading separators would
  // double the run already at the end of `out`, so they go.
  let dropped = false;
  let cursor = 0;
  const appendLiteral = (literal: string): void => {
    let text = sanitize(literal);
    if (dropped && (out === "" || TRAILING_SEPARATORS.test(out))) {
      text = text.replace(LEADING_SEPARATORS, "");
    }
    if (text !== "") dropped = false;
    out += text;
  };
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    appendLiteral(template.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const name = match[1] ?? "";
    if (!isPlaceholder(name)) {
      appendLiteral(match[0]);
      continue;
    }
    const value = sanitize(values[name]).trim();
    if (value === "") {
      dropped = true;
      continue;
    }
    dropped = false;
    out += value;
  }
  appendLiteral(template.slice(cursor));
  const trimmed = out.replace(EDGE_SEPARATORS, "");
  const capped = Array.from(trimmed).slice(0, SESSION_NAME_MAX_LENGTH).join("");
  return capped.replace(EDGE_SEPARATORS, "");
}

/**
 * A control character (C0, DEL or C1: a newline in a title, say) becomes a
 * space. A bidi control goes, since it would reorder the rest of the name.
 */
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARACTERS, " ").replace(BIDI_CONTROLS, "");
}
