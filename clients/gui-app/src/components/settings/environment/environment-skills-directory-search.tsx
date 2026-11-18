import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentSkillSearchResult } from "@traycer/protocol/host/environment/configuration-contracts";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SKILLS_DIRECTORY_MIN_QUERY,
  useSkillsDirectorySearchQuery,
} from "@/hooks/environment/team/use-skills-directory-search-query";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import type { HostRpcRegistry } from "@/lib/host";
import {
  SKILLS_DIRECTORY_NOTE,
  SKILLS_DIRECTORY_NO_RESULTS,
  SKILLS_DIRECTORY_SEARCH_LABEL,
  skillInstallsPhrase,
} from "./mcp-skills-copy";

/** The pause in typing after which the directory is searched. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The public skills directory searched from the import's source step: up
 * to twenty skills for what the person typed, most installed first. Picking
 * one hands it to the import as its source. A directory that answers
 * nothing usable reads as no results.
 */
export function SkillsDirectorySearch(props: {
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly disabled: boolean;
  readonly onPick: (result: EnvironmentSkillSearchResult) => void;
}): ReactNode {
  const [text, setText] = useState("");
  const query = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  const search = useSkillsDirectorySearchQuery(props.hostClient, query);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="skills-directory-search">
        {SKILLS_DIRECTORY_SEARCH_LABEL}
      </Label>
      <Input
        id="skills-directory-search"
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={props.disabled}
        size="sm"
      />
      <p className="text-ui-xs text-muted-foreground">
        {SKILLS_DIRECTORY_NOTE}
      </p>
      <DirectoryResults
        searching={query.length >= SKILLS_DIRECTORY_MIN_QUERY}
        pending={search.isPending}
        results={search.data?.outcome === "found" ? search.data.skills : null}
        disabled={props.disabled}
        onPick={props.onPick}
      />
    </div>
  );
}

/** What the search shows under its box for the query typed. */
function DirectoryResults(props: {
  /** A query long enough to search is typed. */
  readonly searching: boolean;
  readonly pending: boolean;
  /** The directory's results, or `null` when it answered none to show. */
  readonly results: readonly EnvironmentSkillSearchResult[] | null;
  readonly disabled: boolean;
  readonly onPick: (result: EnvironmentSkillSearchResult) => void;
}): ReactNode {
  if (!props.searching) return null;
  if (props.pending) return <MutedAgentSpinner />;
  if (props.results === null || props.results.length === 0)
    return (
      <p role="status" className="text-ui-xs text-muted-foreground">
        {SKILLS_DIRECTORY_NO_RESULTS}
      </p>
    );
  return (
    <ul
      aria-label={SKILLS_DIRECTORY_SEARCH_LABEL}
      className="flex max-h-[30dvh] flex-col gap-1 overflow-y-auto"
    >
      {props.results.map((result) => (
        <li key={result.id}>
          <button
            type="button"
            className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md border border-border/60 px-3 py-2 text-left enabled:hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
            disabled={props.disabled}
            onClick={() => props.onPick(result)}
          >
            <span className="truncate text-ui-sm font-medium text-foreground">
              {result.name}
            </span>
            <span className="truncate text-ui-xs text-muted-foreground">
              {`${result.source} · ${skillInstallsPhrase(result.installs)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
