import type {
  HostNotificationSeverity,
  NotificationHookConfig,
} from "@traycer/protocol/host/notifications/host-notifications";

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
  readonly argsText: string;
};

export function draftFromHook(hook: NotificationHookConfig): HookDraft {
  return {
    id: hook.id,
    name: hook.name ?? "",
    enabled: hook.enabled,
    // `null` on the wire means "any severity"; every reachable severity
    // selected is the same thing, and it is what the switches can show.
    severities: hook.severities ?? HOOK_SEVERITIES.map((entry) => entry.id),
    actionType: hook.action.type,
    url: hook.action.type === "http" ? hook.action.url : "",
    headersText:
      hook.action.type === "http"
        ? Object.entries(hook.action.headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join("\n")
        : "",
    command: hook.action.type === "command" ? hook.action.command : "",
    argsText: hook.action.type === "command" ? hook.action.args.join("\n") : "",
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

export function draftToHook(draft: HookDraft): NotificationHookConfig {
  const shared = {
    id: draft.id,
    name: draft.name.trim().length === 0 ? null : draft.name.trim(),
    enabled: draft.enabled,
    severities: [...draft.severities],
  };
  return draft.actionType === "http"
    ? {
        ...shared,
        action: {
          type: "http",
          url: draft.url.trim(),
          headers: parseHeaders(draft.headersText),
        },
      }
    : {
        ...shared,
        action: {
          type: "command",
          command: draft.command.trim(),
          args: splitLines(draft.argsText),
        },
      };
}

/** Human-readable reason the draft can't be saved yet, or null when valid. */
export function draftProblem(draft: HookDraft): string | null {
  if (draft.severities.length === 0) {
    return "Pick at least one severity.";
  }
  if (draft.actionType === "command") {
    return draft.command.trim().length === 0
      ? "Enter the executable to run."
      : null;
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
    return "Put credentials in a header, not the URL.";
  }
  return null;
}
