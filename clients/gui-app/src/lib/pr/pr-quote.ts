/**
 * Quote-to-chat payloads for the PR full view.
 *
 * The view is read-only (decision #4), so the ONE thing it can do that GitHub
 * cannot is hand a fact to the agent that wrote the branch. Every quotable
 * surface therefore produces a structured block - a provenance header line
 * plus the body - rather than bare selected text, so the receiving agent knows
 * which PR and which kind of finding it is looking at without being told.
 *
 * Reuses the chat quote feature's own primitives (`buildQuoteBlockquote` /
 * `appendQuoteToDraft`), so a quoted PR fact lands in the composer as exactly
 * the same node shape a quoted transcript selection does, and the host flattens
 * both into `<user_quoted_section>` identically.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  PrActivityItem,
  PrChangedFile,
  PrCheckContext,
  PrDetailCore,
  PrReviewThread,
} from "@traycer/protocol/host/pr-schemas";
import {
  appendQuoteToDraft,
  buildQuoteBlockquote,
} from "@/components/chat/quote/append-quote-to-draft";
import {
  formatPrActorName,
  formatPrCheckStatusLabel,
  formatPrReviewStateLabel,
} from "./pr-detail-projection";
import { prReviewThreadAnchor } from "./pr-conversation";

/**
 * A chat or terminal agent a quote can be sent to. `id` is the composer draft
 * key (`taskId`), which is what `appendQuoteToDraft` writes against.
 */
export interface PrQuoteTarget {
  readonly id: string;
  readonly kind: "chat" | "terminal-agent";
  readonly title: string;
  readonly updatedAt: number;
}

/** `owner/repo#number` - the provenance every payload leads with. */
export function formatPrSlug(core: PrDetailCore): string {
  return `${core.base.owner}/${core.base.repo}#${core.base.prNumber}`;
}

function quoteText(
  headerLines: readonly string[],
  body: string | null,
): string {
  const header = headerLines.join("\n");
  if (body === null || body.trim().length === 0) return header;
  return `${header}\n\n${body.trim()}`;
}

export function buildPrOverviewQuote(core: PrDetailCore): JsonContent {
  const state =
    core.isDraft === true && core.state === "open" ? "draft" : core.state;
  return buildQuoteBlockquote({
    text: quoteText(
      [
        `PR ${formatPrSlug(core)} · ${state}`,
        `${core.headRefName ?? "unknown"} → ${core.baseRefName ?? "unknown"}`,
        core.title !== null && core.title.length > 0 ? core.title : null,
      ].filter((line): line is string => line !== null),
      core.body,
    ),
    fenceLanguage: null,
  });
}

export function buildPrCheckQuote(
  core: PrDetailCore,
  context: PrCheckContext,
): JsonContent {
  return buildQuoteBlockquote({
    text: quoteText(
      [
        `PR ${formatPrSlug(core)}`,
        `check ${context.name} · ${formatPrCheckStatusLabel(context)}`,
        context.detailsUrl !== null ? context.detailsUrl : null,
      ].filter((line): line is string => line !== null),
      null,
    ),
    fenceLanguage: null,
  });
}

export function buildPrActivityQuote(
  core: PrDetailCore,
  item: PrActivityItem,
): JsonContent {
  const who = formatPrActorName(item.author);
  const kindLine =
    item.kind === "review"
      ? `review ${who} · ${formatPrReviewStateLabel(item.state).toLowerCase()}`
      : `comment ${who}`;
  return buildQuoteBlockquote({
    text: quoteText([`PR ${formatPrSlug(core)}`, kindLine], item.body),
    fenceLanguage: null,
  });
}

/**
 * Quotes one inline finding.
 *
 * The anchor goes in the header rather than the body, because it is the part
 * an agent needs to act: "fix this" is unactionable without the file and line
 * it points at. An outdated thread quotes its ORIGINAL line and says so - a
 * current line number it no longer has would send the agent to the wrong place.
 */
export function buildPrReviewThreadQuote(
  core: PrDetailCore,
  thread: PrReviewThread,
): JsonContent {
  const anchor = prReviewThreadAnchor(thread);
  const first = thread.comments.at(0);
  const who = formatPrActorName(first?.author ?? null);
  return buildQuoteBlockquote({
    text: quoteText(
      [
        `PR ${formatPrSlug(core)}`,
        `inline comment ${who}`,
        anchor.isOriginal ? `${anchor.label} (as reviewed)` : anchor.label,
      ],
      thread.comments.map((comment) => comment.body).join("\n\n"),
    ),
    fenceLanguage: null,
  });
}

export function buildPrFileQuote(
  core: PrDetailCore,
  file: PrChangedFile,
): JsonContent {
  const counts = [
    file.additions !== null ? `+${file.additions}` : null,
    file.deletions !== null ? `-${file.deletions}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  return buildQuoteBlockquote({
    text: quoteText(
      [
        `PR ${formatPrSlug(core)}`,
        `file ${file.path}${counts.length > 0 ? ` · ${counts}` : ""}`,
      ],
      null,
    ),
    fenceLanguage: null,
  });
}

/** Description alone, for the Overview body's own quote affordance. */
export function buildPrDescriptionQuote(core: PrDetailCore): JsonContent {
  return buildQuoteBlockquote({
    text: quoteText([`PR ${formatPrSlug(core)} · description`], core.body),
    fenceLanguage: null,
  });
}

/**
 * Sends a built payload to a target's composer draft. Thin on purpose: the
 * draft store, focus behaviour and node shape are all the chat quote feature's,
 * so a PR quote and a transcript quote can never drift apart.
 */
export function sendPrQuoteToTarget(
  target: PrQuoteTarget,
  node: JsonContent,
): void {
  appendQuoteToDraft(target.id, node);
}
