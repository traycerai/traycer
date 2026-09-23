/**
 * How an Auto mode rule reads on screen, and the rule a user is offered when
 * they want the judge to stop asking about one.
 *
 * Shared by the approval card and Settings ▸ Permissions (Rules and Activity),
 * so the card's chip, the Activity row and the drafted rule all spell a rule
 * the same way.
 */
import type { AutoJudgeTier } from "@traycer/protocol/host/auto-mode/contracts";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";

/**
 * A word that is only title-cased: "Push" or "A", not "API", "GitHub" or
 * "npm". A lone capital is an article in a title-cased name ("Disabling A
 * Security Control"), so it is lowered with the rest.
 */
const TITLE_CASED_WORD = /^\p{Lu}\p{Ll}*$/u;

/**
 * A rule name in sentence case: "Force Push" -> "Force push", "Disabling A
 * Security Control" -> "Disabling a security control".
 *
 * DISPLAY ONLY. The wire keeps the host's exact category string, which is the
 * name the judge was told to spell exactly and the key the journal and
 * analytics count by; nothing may compare against what this returns.
 *
 * Only a word that is plainly title-cased is lowered, so an acronym or a
 * mixed-case name inside a rule ("API", "GitHub") survives, and so does a name
 * the model invented in its own casing. The first letter is raised, which is
 * all a sentence needs from a name that arrived lower-case.
 */
export function autoModeRuleDisplayName(rule: string): string {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return trimmed;
  // Split on whitespace and hyphens, keeping them, so "Read-Only Inspection"
  // keeps its hyphen and lowers both halves after the first word.
  const parts = trimmed.split(/(\s+|-)/u);
  let seenWord = false;
  const cased = parts.map((part) => {
    if (part.length === 0 || /^(\s+|-)$/u.test(part)) return part;
    if (!seenWord) {
      seenWord = true;
      return part.charAt(0).toUpperCase() + part.slice(1);
    }
    return TITLE_CASED_WORD.test(part) ? part.toLowerCase() : part;
  });
  return cased.join("");
}

/**
 * The one line under an escalated card's reason, keyed by the rule tier the
 * host sends with it.
 *
 * `null` - a host older than `chat.subscribe@1.16`, or a reason with no tier
 * (the judge could not run) - renders nothing: the card never guesses a tier
 * from the rule name, because a rule can change tier between host versions.
 */
export function autoJudgeTierLine(tier: AutoJudgeTier | null): string | null {
  switch (tier) {
    case "soft":
      return "Sent to you because you didn't ask for this exact action.";
    case "hard":
      return "Always sent to you.";
    case "policy":
      return "Sent to you by one of your rules.";
    case "unsure":
      return "The judge wasn't sure.";
    case null:
      return null;
  }
}

/** The link that follows the `soft` tier line and opens a drafted rule. */
export const AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL = "Allow from now on…";

/**
 * What the client knows about where a conversation runs, for narrowing a
 * drafted rule. Either part is `null` when the client does not know it.
 */
export interface AutoModeRuleDraftWorkspace {
  /** `owner/repo` of the workspace's remote. */
  readonly remote: string | null;
  /** The worktree branch the conversation runs on. */
  readonly branch: string | null;
}

const UNKNOWN_DRAFT_WORKSPACE: AutoModeRuleDraftWorkspace = {
  remote: null,
  branch: null,
};

/**
 * The remote and branch a chat's workspace binding records, from its primary
 * folder (the first folder when none is marked primary).
 *
 * The remote is `owner/repo`, which is what the binding keeps: it is parsed
 * from the folder's remote URL, and the judge sees that URL in its workspace
 * section, so a rule naming `owner/repo` is one it can match. The branch is
 * only known for a folder on a worktree; a folder used in place has no branch
 * on its binding, and the draft leaves the clause out rather than guess.
 */
export function autoModeRuleDraftWorkspace(
  binding: WorktreeBinding | null,
): AutoModeRuleDraftWorkspace {
  if (binding === null) return UNKNOWN_DRAFT_WORKSPACE;
  const entry =
    binding.entries.find((candidate) => candidate.isPrimary) ??
    binding.entries.at(0);
  if (entry === undefined) return UNKNOWN_DRAFT_WORKSPACE;
  const remote =
    entry.repoIdentifier === null
      ? null
      : `${entry.repoIdentifier.owner}/${entry.repoIdentifier.repo}`;
  const branch =
    entry.branch !== null && entry.branch.trim().length > 0
      ? entry.branch.trim()
      : null;
  return { remote, branch };
}

/**
 * The prepared "Always allow" rule for an action the judge sent to a person:
 * "In {remote}: {rule name} for `{input}` on branch {branch}".
 *
 * NARROW BY CONSTRUCTION. The account policy is the one channel that widens
 * what the judge allows, and it applies on every machine and in every
 * repository, so the draft names every fact the judge can check in its own
 * workspace section - the remote, the branch, the exact input - and leaves out
 * only what the client does not know. The minimum is "{rule name} for
 * `{input}`". It is a draft: the Rules tab shows it for editing, and nothing
 * saves it by itself.
 */
export function autoModeRuleDraftText(input: {
  readonly workspace: AutoModeRuleDraftWorkspace;
  /** The rule as displayed ({@link autoModeRuleDisplayName}). */
  readonly ruleName: string;
  /** The action's one-line input, or `null` when there is none to quote. */
  readonly inputSummary: string | null;
}): string {
  const { workspace, ruleName } = input;
  const summary =
    input.inputSummary === null
      ? ""
      : input.inputSummary.replace(/\s+/gu, " ").trim();
  let text = ruleName;
  if (summary.length > 0) text = `${text} for ${inlineCode(summary)}`;
  if (workspace.branch !== null) text = `${text} on branch ${workspace.branch}`;
  if (workspace.remote !== null) text = `In ${workspace.remote}: ${text}`;
  return text;
}

/**
 * `text` as a Markdown code span, with a fence longer than any backtick run
 * inside it, so a command that itself contains backticks stays one span.
 */
function inlineCode(text: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  const padded =
    text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}
