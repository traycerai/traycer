import { useMemo } from "react";
import { Monitor } from "lucide-react";
import {
  backEntry,
  scoreLabelAndId,
  type MentionFlowStep,
  type MentionMenuEntry,
} from "@/lib/composer/mentions";
import { rootRankingQuery } from "@/lib/composer/mentions/providers";
import {
  rankRootSearchEntries,
  type RankedRootSearch,
  type RootSearchCandidate,
} from "@/lib/composer/mentions/root-search-ranking";
import { MENU_ICON_CLASS } from "@/lib/composer/mentions/mention-entry-display";

export interface MentionHost {
  readonly hostId: string;
  readonly label: string;
}

/** Hosts remain mentionable when unavailable. */
export function useHostMentionEntries(
  step: MentionFlowStep,
  query: string,
  existing: RankedRootSearch,
  source: {
    readonly hosts: ReadonlyArray<MentionHost>;
    readonly answered: boolean;
  },
): RankedRootSearch {
  const { hosts, answered } = source;
  return useMemo(() => {
    const inHosts = step.kind === "provider" && step.providerId === "hosts";
    if (step.kind !== "root" && !inHosts) return existing;
    const hostEntries: MentionMenuEntry[] = hosts
      .flatMap((host) => {
        const score = scoreLabelAndId(
          host.label,
          host.hostId,
          query.trim().toLowerCase(),
        );
        if (score === null) return [];
        const entry: MentionMenuEntry = {
          id: `host:${host.hostId}`,
          labelPrefix: null,
          label: host.label,
          detail: "Host",
          description: host.hostId,
          searchText: host.hostId,
          disabledReason: null,
          icon: <Monitor className={MENU_ICON_CLASS} aria-hidden />,
          action: {
            kind: "complete",
            mention: {
              kind: "mention",
              contextType: "host",
              hostId: host.hostId,
              path: host.label,
              pathKind: null,
              relPath: null,
              absolutePath: null,
              workspacePath: null,
              label: host.label,
              description: host.hostId,
            },
          },
          updatedAt: null,
          archived: false,
          dormant: false,
          preview: null,
        };
        return [{ entry, score }];
      })
      .toSorted((left, right) => left.score - right.score)
      .map(({ entry }) => entry);
    if (inHosts) {
      return {
        entries: [backEntry("Mentions"), ...hostEntries],
        matchedCount: null,
      };
    }
    const category: MentionMenuEntry = {
      id: "provider:hosts",
      labelPrefix: null,
      label: "Hosts",
      detail: "",
      description: "Hosts",
      searchText: hostEntries.length > 0 ? query : null,
      disabledReason: null,
      icon: <Monitor className={MENU_ICON_CLASS} aria-hidden />,
      action: {
        kind: "navigate",
        step: {
          kind: "provider",
          providerId: "hosts",
          stepId: "root",
          workspacePath: null,
        },
        clearQuery: query.trim().length > 0 && hostEntries.length === 0,
      },
      updatedAt: null,
      archived: false,
      dormant: false,
      preview: null,
    };
    const categoryMatches =
      query.trim().length === 0 ||
      hostEntries.length > 0 ||
      scoreLabelAndId("Hosts", "hosts", query.trim().toLowerCase()) !== null;
    const candidates: RootSearchCandidate[] =
      hosts.length === 0 || !categoryMatches
        ? []
        : [
            {
              entry: category,
              providerId: "hosts",
              path: null,
              pickedAt: null,
            },
          ];
    if (query.trim().length === 0)
      return {
        entries: [...candidates.map(({ entry }) => entry), ...existing.entries],
        matchedCount: null,
      };
    const ranked = rankRootSearchEntries(
      [...(existing.candidates ?? []), ...candidates],
      rootRankingQuery(query),
    );
    return { ...ranked, matchedCount: answered ? ranked.matchedCount : null };
  }, [existing, hosts, query, step, answered]);
}
