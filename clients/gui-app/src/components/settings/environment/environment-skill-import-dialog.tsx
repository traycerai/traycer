import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS,
  type EnvironmentConfigurationSkillImportResponse,
  type EnvironmentSkillSearchResult,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { ProviderSkillInspectCandidate } from "@traycer/protocol/host/provider-native-schemas";
import {
  ImportFields,
  PickerFields,
} from "@/components/settings/panels/provider-skill-composer-dialog";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEnvironmentSkillHostMutations } from "@/hooks/environment/team/use-environment-skills";
import type { HostRpcRegistry } from "@/lib/host";
import { useConfigurationSource } from "./configuration-source";
import { SkillsDirectorySearch } from "./environment-skills-directory-search";
import { useConfigurationName } from "./mcp-servers-model";
import {
  IMPORT_SKILL_DESCRIPTION,
  IMPORT_SKILL_TITLE,
  IMPORT_SOURCE_HINT,
  skillImportLimitLine,
  skillImportRefusal,
} from "./mcp-skills-copy";

/** The source's skills as the viewing host read them, and the token that installs them. */
type Inspected = {
  readonly token: string;
  readonly candidates: readonly ProviderSkillInspectCandidate[];
};

/**
 * What Select all chooses: the skills the configuration does not have yet,
 * in the source's order, no more than one import installs.
 */
function selectableNames(
  candidates: readonly ProviderSkillInspectCandidate[],
): readonly string[] {
  return candidates
    .filter((candidate) => !candidate.installed)
    .slice(0, ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS)
    .map((candidate) => candidate.name);
}

/**
 * What a read source starts with chosen: the one skill a directory pick
 * named (`slug`, its folder or its name), else what Select all chooses.
 */
function initialSelection(
  candidates: readonly ProviderSkillInspectCandidate[],
  slug: string | null,
): readonly string[] {
  const picked =
    slug === null
      ? undefined
      : candidates.find(
          (candidate) =>
            !candidate.installed &&
            (candidate.name === slug ||
              candidate.relPath.split("/").at(-1) === slug),
        );
  return picked === undefined ? selectableNames(candidates) : [picked.name];
}

/** What an import answer that installed nothing tells the person. */
function importProblem(
  result: Exclude<
    EnvironmentConfigurationSkillImportResponse,
    { readonly outcome: "inspected" | "installed" }
  >,
  configuration: string,
): string {
  switch (result.outcome) {
    case "refused":
      return skillImportRefusal(result.reason, result.name, configuration);
    case "stale":
      return `${configuration}'s skills changed while importing. Try again.`;
    case "forbidden":
      return `You can't change ${configuration}'s skills.`;
    case "not_served":
      return "Couldn't import from this source.";
  }
}

/**
 * Skills from a git source into the configuration, on its viewing host: the
 * source read first, then the skills chosen from it installed together.
 * Skills the configuration already has are left unchosen; choosing one is
 * refused until it is removed.
 */
export function EnvironmentSkillImportDialog(props: {
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  /** The viewing host searches the public skills directory. */
  readonly searchable: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const source = useConfigurationSource();
  const configuration = useConfigurationName();
  const { importSkills } = useEnvironmentSkillHostMutations(props.hostClient);
  const [text, setText] = useState("");
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = importSkills.isPending;
  const selectable =
    inspected === null ? [] : selectableNames(inspected.candidates);
  // More of the source's skills than one import installs.
  const overLimit =
    inspected !== null &&
    inspected.candidates.filter((candidate) => !candidate.installed).length >
      ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS;

  // `slug` is the skill a directory pick named, chosen alone once read.
  const inspect = (from: string, slug: string | null): void => {
    if (source.kind !== "pool") return;
    setProblem(null);
    importSkills.mutate(
      {
        step: "inspect",
        environmentId: source.environmentId,
        source: from,
      },
      {
        onSuccess: (result) => {
          if (result.outcome === "installed") return;
          if (result.outcome !== "inspected") {
            setProblem(importProblem(result, configuration));
            return;
          }
          setInspected({ token: result.token, candidates: result.candidates });
          setSelected(initialSelection(result.candidates, slug));
        },
      },
    );
  };

  const install = (): void => {
    if (source.kind !== "pool" || inspected === null) return;
    setProblem(null);
    importSkills.mutate(
      {
        step: "install",
        environmentId: source.environmentId,
        token: inspected.token,
        names: [...selected],
      },
      {
        onSuccess: (result) => {
          if (result.outcome === "installed") {
            props.onClose();
            return;
          }
          if (result.outcome === "inspected") return;
          // A source that moved is read again from the source step.
          if (result.outcome === "refused" && result.reason === "expired")
            setInspected(null);
          setProblem(importProblem(result, configuration));
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{IMPORT_SKILL_TITLE}</DialogTitle>
          <DialogDescription>{IMPORT_SKILL_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {inspected === null ? (
            <>
              {props.searchable ? (
                <SkillsDirectorySearch
                  hostClient={props.hostClient}
                  disabled={pending}
                  onPick={(result: EnvironmentSkillSearchResult) => {
                    // As if typed and read: the source, then its skills.
                    setText(result.source);
                    inspect(
                      result.source,
                      result.id.slice(result.source.length + 1),
                    );
                  }}
                />
              ) : null}
              <ImportFields
                source={text}
                setSource={setText}
                hint={IMPORT_SOURCE_HINT}
                disabled={pending}
                canWrite={false}
                onWrite={() => undefined}
              />
            </>
          ) : (
            <PickerFields
              candidates={inspected.candidates}
              selectedNames={selected}
              note={
                overLimit
                  ? skillImportLimitLine(ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS)
                  : null
              }
              disabled={pending}
              selectableNames={selectable}
              limit={ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS}
              onToggle={(candidateName) =>
                setSelected(
                  selected.includes(candidateName)
                    ? selected.filter((entry) => entry !== candidateName)
                    : [...selected, candidateName],
                )
              }
              onToggleAll={() =>
                setSelected(
                  selectable.every((candidateName) =>
                    selected.includes(candidateName),
                  )
                    ? []
                    : selectable,
                )
              }
              onBack={() => {
                setInspected(null);
                setSelected([]);
                setProblem(null);
              }}
            />
          )}
          {problem === null ? null : (
            <p role="status" className="text-ui-xs text-warning-foreground">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          {inspected === null ? (
            <Button
              type="button"
              disabled={pending || text.trim().length === 0}
              onClick={() => inspect(text.trim(), null)}
            >
              Read source
              {pending ? <MutedAgentSpinner /> : null}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={
                pending ||
                selected.length === 0 ||
                selected.length > ENVIRONMENT_SKILL_IMPORT_MAX_SKILLS
              }
              onClick={install}
            >
              {selected.length === 1
                ? "Import 1 skill"
                : `Import ${String(selected.length)} skills`}
              {pending ? <MutedAgentSpinner /> : null}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
