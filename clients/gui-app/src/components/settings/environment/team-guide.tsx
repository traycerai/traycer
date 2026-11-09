import { useState, type ReactNode } from "react";
import { AgentSelectionGuideEditorSurface } from "@/components/agent-selection-guide-editor-surface";
import { MarkdownEditPreview } from "@/components/markdown-edit-preview";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useBoundedRead } from "@/hooks/environment/team/use-bounded-read";
import {
  useConfigurationGuideQuery,
  useConfigurationGuideMutations,
  useConfigurationGuideWritable,
} from "@/hooks/environment/team/use-guide-query";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import {
  useCanEditConfiguration,
  useConfigurationSource,
  useConfigurationIsPersonal,
} from "./configuration-source";
import { ConfigurationWriteFeedback } from "./configuration-write-feedback";
import {
  typedWriteIssue,
  type ConfigurationWriteIssue,
} from "./configuration-write-issue";
import { useConfigurationName } from "./team-pick-label";
import { TeamContentNeedsHost } from "./team-content-needs-host";
import { TeamViewingHostPicker } from "./team-viewing-host-picker";
import { ConfigurationReadFailed } from "./team-read-failed";

export function TeamGuide(): ReactNode {
  const scope = useTeamViewingHost();
  const query = useConfigurationGuideQuery();
  const read = useBoundedRead(query);
  const canEdit = useCanEditConfiguration();
  const name = useConfigurationName();
  const writable = useConfigurationGuideWritable();
  const [picking, setPicking] = useState(false);
  const [writing, setWriting] = useState(false);
  const [issue, setIssue] = useState<ConfigurationWriteIssue>(null);
  const data = query.data;
  const editable = canEdit && writable;
  let body: ReactNode = <MutedAgentSpinner />;
  // A build with no server pool reads the guide from the picked host, which
  // answers `not_served` when it does not run this configuration.
  if (data?.outcome === "not_served")
    body = (
      <TeamContentNeedsHost
        content="guide"
        teamName={name}
        onPickHost={() => setPicking(true)}
      />
    );
  else if (read.failed && query.data === undefined)
    body = (
      <ConfigurationReadFailed page="selection guide" onRetry={read.retry} />
    );
  else if (data?.outcome === "unset")
    body =
      writing && editable ? (
        <TeamGuideEditor
          key={`unset:${data.revision}`}
          text=""
          revision={data.revision}
          onIssue={setIssue}
        />
      ) : (
        <TeamGuideUnset onWrite={editable ? () => setWriting(true) : null} />
      );
  else if (data?.outcome === "ok") {
    body = editable ? (
      <TeamGuideEditor
        key={`${scope.viewingHost?.hostId}:${data.revision}`}
        text={data.text}
        revision={data.revision}
        onIssue={setIssue}
      />
    ) : (
      <MarkdownEditPreview
        value={data.text}
        onChange={() => {}}
        readOnly
        placeholder={undefined}
        ariaLabel="Agent selection guide"
        testId="team-guide-read-only"
        showPreview={false}
      />
    );
  }
  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-5">
      <TeamViewingHostPicker open={picking} onOpenChange={setPicking} />
      <ConfigurationWriteFeedback issue={issue} />
      {body}
    </section>
  );
}

/**
 * A configuration whose room holds no guide yet: its agents get the default
 * until someone saves one. `onWrite` is null for a reader who cannot edit.
 */
function TeamGuideUnset(props: {
  readonly onWrite: (() => void) | null;
}): ReactNode {
  const name = useConfigurationName();
  return (
    <p
      role="status"
      className="flex flex-wrap items-baseline gap-x-1 text-ui-sm text-muted-foreground"
    >
      {`${name}'s agents use the default selection guide until someone saves one.`}
      {props.onWrite === null ? null : (
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={props.onWrite}
        >
          Write one
        </Button>
      )}
    </p>
  );
}

function TeamGuideEditor(props: {
  readonly text: string;
  readonly revision: string;
  /** A save's or a reset's answer: a lost compare-and-set, or not saved. */
  readonly onIssue: (issue: ConfigurationWriteIssue) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const personal = useConfigurationIsPersonal();
  const teamName = useConfigurationName();
  const { set, reset } = useConfigurationGuideMutations();
  const [value, setValue] = useState(props.text);
  const [confirm, setConfirm] = useState(false);
  const save = (): void => {
    if (source.kind !== "pool") return;
    set.mutate(
      {
        environmentId: source.environmentId,
        text: value,
        revision: props.revision,
      },
      {
        onSuccess: (result) =>
          props.onIssue(typedWriteIssue(result, "Couldn't save the guide.")),
      },
    );
  };
  return (
    <>
      <AgentSelectionGuideEditorSurface
        titleId="team-guide-heading"
        value={value}
        onValueChange={setValue}
        onBlur={null}
        disabled={set.isPending || reset.isPending}
        placeholder={undefined}
        ariaLabel="Agent selection guide"
        testId="team-guide-input"
        editorClassName="flex-1"
        className="h-full"
        revertDisabled={set.isPending || reset.isPending}
        onRevert={() => setConfirm(true)}
        revertTestId="team-guide-revert"
        status={
          <Button
            type="button"
            size="sm"
            disabled={value === props.text || set.isPending || reset.isPending}
            onClick={save}
          >
            Save{set.isPending ? <MutedAgentSpinner /> : null}
          </Button>
        }
      />
      <ConfirmDestructiveDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Reset to default instructions?"
        description={
          personal
            ? "This replaces your selection guide with the default on every computer and sandbox running Personal. Your changes to it are lost."
            : `This replaces ${teamName}'s selection guide with the default for every member. Changes anyone made to it are lost.`
        }
        cascadeSummary={null}
        actionLabel="Reset to default"
        isPending={reset.isPending}
        blockedReason={null}
        onConfirm={() => {
          if (source.kind === "pool")
            reset.mutate(
              { environmentId: source.environmentId },
              {
                onSuccess: (result) => {
                  setConfirm(false);
                  props.onIssue(
                    typedWriteIssue(result, "Couldn't reset the guide."),
                  );
                },
              },
            );
        }}
      />
    </>
  );
}
