import type {
  HostNotificationSeverity,
  NotificationHookConfig,
} from "@traycer/protocol/host/notifications/host-notifications";
import { urlCarriesCredentials } from "@/components/providers/credential-bearing-values";

/**
 * The severities a notification can actually carry, in the same order and
 * wording as the Interruptions matrix. `info` is omitted for the same reason
 * the matrix omits it: no notification kind emits it today.
 */
export const HOOK_SEVERITIES: ReadonlyArray<{
  readonly id: HostNotificationSeverity;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "needs_action",
    label: "Needs action",
    description: "Approvals and interviews.",
  },
  {
    id: "failure",
    label: "Failure",
    description: "Errored turns, stalls, crashes, and rate limits.",
  },
  {
    id: "done",
    label: "Done",
    description: "Completed or intentionally stopped turns.",
  },
];

/**
 * Editing shape for one hook: headers and args stay raw text so a half-typed
 * line survives keystrokes, and are parsed once on save.
 */
export type HookDraft = {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /**
   * Full severity list as the file holds it. The form renders one switch per
   * reachable severity; any severity outside that set (e.g. a hand-authored
   * `info`) simply rides along untouched, so editing never drops it.
   */
  readonly severities: readonly HostNotificationSeverity[];
  readonly actionType: "http" | "command";
  readonly url: string;
  readonly headersText: string;
  readonly command: string;
  /** One argument per line, each as typed. */
  readonly argsText: string;
  /**
   * The saved hook this draft edits, or null for a new one. A field that
   * still shows its saved value goes back exactly as the hook holds it.
   */
  readonly held: NotificationHookConfig | null;
};

type HttpAction = Extract<NotificationHookConfig["action"], { type: "http" }>;
type CommandAction = Extract<
  NotificationHookConfig["action"],
  { type: "command" }
>;

/** The severities the switches show for `held`. */
function shownSeverities(
  held: NotificationHookConfig["severities"],
): HostNotificationSeverity[] {
  // `null` on the wire means "any severity"; every reachable severity
  // selected is the same thing, and it is what the switches can show.
  return held === null ? HOOK_SEVERITIES.map((entry) => entry.id) : [...held];
}

function headersText(headers: HttpAction["headers"]): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

export function draftFromHook(hook: NotificationHookConfig): HookDraft {
  return {
    id: hook.id,
    name: hook.name ?? "",
    enabled: hook.enabled,
    severities: shownSeverities(hook.severities),
    actionType: hook.action.type,
    url: hook.action.type === "http" ? hook.action.url : "",
    headersText:
      hook.action.type === "http" ? headersText(hook.action.headers) : "",
    command: hook.action.type === "command" ? hook.action.command : "",
    argsText: hook.action.type === "command" ? hook.action.args.join("\n") : "",
    held: hook,
  };
}

export function emptyDraft(): HookDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: false,
    severities: HOOK_SEVERITIES.map((entry) => entry.id),
    actionType: "command",
    url: "",
    headersText: "",
    command: "",
    argsText: "",
    held: null,
  };
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(":");
    const name = (
      separator === -1 ? trimmed : trimmed.slice(0, separator)
    ).trim();
    if (name.length === 0) continue;
    headers[name] = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  }
  return headers;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function draftName(draft: HookDraft): string | null {
  if (draft.held !== null && draft.name === (draft.held.name ?? ""))
    return draft.held.name;
  const typed = draft.name.trim();
  return typed.length === 0 ? null : typed;
}

function draftSeverities(
  draft: HookDraft,
): NotificationHookConfig["severities"] {
  if (draft.held === null) return [...draft.severities];
  const shown = shownSeverities(draft.held.severities);
  const unchanged =
    shown.length === draft.severities.length &&
    shown.every((severity) => draft.severities.includes(severity));
  return unchanged ? draft.held.severities : [...draft.severities];
}

function httpAction(draft: HookDraft): HttpAction {
  const action = draft.held === null ? null : draft.held.action;
  const held = action !== null && action.type === "http" ? action : null;
  return {
    type: "http",
    url: held !== null && draft.url === held.url ? held.url : draft.url.trim(),
    headers:
      held !== null && draft.headersText === headersText(held.headers)
        ? { ...held.headers }
        : parseHeaders(draft.headersText),
  };
}

function commandAction(draft: HookDraft): CommandAction {
  const action = draft.held === null ? null : draft.held.action;
  const held = action !== null && action.type === "command" ? action : null;
  return {
    type: "command",
    command:
      held !== null && draft.command === held.command
        ? held.command
        : draft.command.trim(),
    args:
      held !== null && draft.argsText === held.args.join("\n")
        ? [...held.args]
        : typedArgs(draft.argsText),
  };
}

/** One argument per line, each as typed. */
function typedArgs(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

/**
 * The hook a save writes. A field the person left as it was goes back
 * exactly as the saved hook holds it: parsing its text back would rewrite
 * values the save never changed (a padded argument, an empty one, a header
 * value's spacing, `null` severities).
 */
export function draftToHook(draft: HookDraft): NotificationHookConfig {
  return {
    id: draft.id,
    name: draftName(draft),
    enabled: draft.enabled,
    severities: draftSeverities(draft),
    action:
      draft.actionType === "http" ? httpAction(draft) : commandAction(draft),
  };
}

/**
 * Human-readable reason the draft can't be saved yet, or null when valid.
 * With `credentialRefusal` (the host takes no credentials), a draft that
 * carries one - a header value, or a URL with a sign-in in the executable or
 * an argument - is refused with that line.
 */
export function draftProblem(
  draft: HookDraft,
  credentialRefusal: string | null,
): string | null {
  if (draft.severities.length === 0) {
    return "Pick at least one severity.";
  }
  if (draft.actionType === "command") {
    if (draft.command.trim().length === 0) {
      return "Enter the executable to run.";
    }
    if (
      credentialRefusal !== null &&
      [draft.command, ...splitLines(draft.argsText)].some(urlCarriesCredentials)
    ) {
      return `${credentialRefusal}: remove the sign-in from its URLs to save this hook here.`;
    }
    return null;
  }
  const url = draft.url.trim();
  if (url.length === 0) return "Enter a URL.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter an absolute http(s) URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The URL must be http(s).";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return credentialRefusal === null
      ? "Put credentials in a header, not the URL."
      : `${credentialRefusal}: remove the sign-in from the URL to save this hook here.`;
  }
  if (
    credentialRefusal !== null &&
    Object.values(parseHeaders(draft.headersText)).some(
      (value) => value.length > 0,
    )
  ) {
    return `${credentialRefusal}: remove the header values to save this hook here.`;
  }
  return null;
}
