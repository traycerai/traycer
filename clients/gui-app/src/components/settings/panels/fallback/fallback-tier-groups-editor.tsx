import { type ReactNode } from "react";
import { toast } from "sonner";
import type {
  FallbackPolicy,
  TierCandidate,
  TierCandidatePreview,
} from "@traycer/protocol/host/fallback-policy";
import {
  toWireGroups,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";
import { SettingsGroup } from "@/components/settings/settings-group";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { FallbackTierGroupCard } from "@/components/settings/panels/fallback/fallback-tier-group-card";

/**
 * The harness a brand-new row starts on when nothing else can supply one.
 *
 * Annotated against the candidate's own field type rather than left as a bare
 * string, so removing this member from the harness union is a compile error
 * here instead of a seed that silently stops validating. It is only an INITIAL
 * value - the row carries its own provider select - so being wrong for a given
 * user costs one click.
 *
 * Not exported: `react(only-export-components)` bans a non-component export
 * from a `.tsx`, and nothing outside this module needs it.
 */
const SEED_HARNESS_ID: TierCandidate["harnessId"] = "claude";

export interface FallbackTierGroupsEditorProps {
  /**
   * The policy every other control on the panel is editing. Read here only to
   * carry the untouched fields through onto the next value - this editor owns
   * `tierGroups` and nothing else on it.
   */
  readonly policy: FallbackPolicy;
  /**
   * What this editor RENDERS: the same groups, with a client-side identity on
   * every candidate row. Held by the panel's draft reducer rather than derived
   * here, so an identity outlives a re-render and a save (see
   * `fallback-tier-group-keys.ts`).
   */
  readonly groups: readonly KeyedGroup[];
  /**
   * Every preview row across every group, flat, exactly as the host returns
   * them. `null` means no preview is available - an older host, or a read that
   * has not landed.
   */
  readonly preview: readonly TierCandidatePreview[] | null;
  /** Names the account a preview row resolved on - never its raw id (D190). */
  readonly labelFor: FallbackSettingsProfileLabel;
  readonly previewPending: boolean;
  /**
   * A draft move that is NOT saved: a keystroke in the group-name or model-family
   * field. The value on screen follows it and so does the inline validation
   * message; the host hears nothing until {@link onCommit}.
   */
  readonly onChange: (
    next: FallbackPolicy,
    groups: readonly KeyedGroup[],
  ) => void;
  /**
   * A completed edit, to save. Every control except a text field commits through
   * here on its own interaction; a text field commits on blur or Enter.
   *
   * Both callbacks carry both halves of the edit - the policy, and the identities
   * the rows have afterwards - because only this editor knows which row an
   * insert, a removal or a move produced. The wire policy alone cannot say, which
   * is the whole reason the identities exist.
   */
  readonly onCommit: (
    next: FallbackPolicy,
    groups: readonly KeyedGroup[],
  ) => void;
  /** "Restore the default groups" - the RESTORE op, not a client-built list. */
  readonly onRestoreDefaults: () => void;
  readonly restorePending: boolean;
  readonly status: ReactNode;
}

/**
 * Settings ▸ Fallback ▸ Equivalent models.
 *
 * The user's statement about which models are interchangeable, which is the
 * only thing that makes the "switch to an equivalent model" step possible: the
 * host will not move a chat from a standard model to a frontier one, or the
 * reverse, on its own guess.
 *
 * The vocabulary here is "model groups" throughout - never "tier", "ladder" or
 * "rung", which are engine words that appear nowhere on this surface.
 */
export function FallbackTierGroupsEditor(
  props: FallbackTierGroupsEditorProps,
): ReactNode {
  const {
    policy,
    groups,
    preview,
    labelFor,
    previewPending,
    onChange,
    onCommit,
    onRestoreDefaults,
    restorePending,
    status,
  } = props;

  // The one place the keyed form is projected back to the wire form. Every edit
  // below builds a new keyed list and goes through here, so identity never
  // leaves this module in a saved policy and never has to be reconstructed on
  // the way back in.
  const toPolicy = (next: readonly KeyedGroup[]): FallbackPolicy => ({
    ...policy,
    tierGroups: [...toWireGroups(next)],
  });
  const emitDraft = (next: readonly KeyedGroup[]): void => {
    onChange(toPolicy(next), next);
  };
  const emit = (next: readonly KeyedGroup[]): void => {
    onCommit(toPolicy(next), next);
  };

  return (
    <SettingsGroup
      title="Equivalent models"
      tone="default"
      dataTestId="settings-fallback-tier-groups"
      fill={false}
    >
      <div className="px-5 py-4">
        <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
          Models you consider interchangeable. When one fails, the
          &ldquo;equivalent model&rdquo; step tries the others in this order.
        </p>
        {groups.length === 0 ? (
          <EmptyGroups
            onRestoreDefaults={onRestoreDefaults}
            restorePending={restorePending}
          />
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {groups.map((group, index) => (
              <FallbackTierGroupCard
                // The id alone, no index: `fallbackPolicySchema` refines group
                // ids to be unique, so this is collision-free by construction.
                // The index was belt-and-braces that cost correctness - it
                // makes React reuse the node at a position rather than follow
                // the group, which is the bug `no-array-index-key` names.
                key={group.id}
                group={group}
                preview={previewForGroup(preview, group.id)}
                labelFor={labelFor}
                defaultHarnessId={firstHarnessId(groups)}
                onChange={(next) => {
                  emitDraft(
                    groups.map((existing, at) =>
                      at === index ? next : existing,
                    ),
                  );
                }}
                onCommit={(next) => {
                  emit(
                    groups.map((existing, at) =>
                      at === index ? next : existing,
                    ),
                  );
                }}
                onDelete={() => {
                  // Undo restores the groups as they were BEFORE this delete,
                  // not a reconstruction of the group: reconstructing would put
                  // it back at the end and lose its position, and position is
                  // the one thing a user cannot re-enter by typing. Restoring
                  // the list also restores its rows' identities, so undo brings
                  // back the same rows rather than lookalikes.
                  const previous = groups;
                  emit(groups.filter((_, at) => at !== index));
                  toast.success(`Deleted “${group.id}”`, {
                    action: {
                      label: "Undo",
                      onClick: () => {
                        emit(previous);
                      },
                    },
                  });
                }}
              />
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-8"
            onClick={() => {
              emit([...groups, { id: nextGroupName(groups), candidates: [] }]);
            }}
          >
            Add a group
          </Button>
          {previewPending ? (
            <span className="flex items-center gap-2 text-ui-xs text-muted-foreground">
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant="orbit"
              />
              Checking what these resolve to…
            </span>
          ) : null}
        </div>
        {status}
      </div>
    </SettingsGroup>
  );
}

/**
 * The zero-groups state, and the distinction it has to make.
 *
 * Empty is a state a user can REACH by deleting their groups, and it is not the
 * same as never having had any: the host seeds defaults on a first read and
 * marks the user, so an empty list means "you emptied this", not "nothing has
 * been set up". Restoring is therefore an explicit action with its own verb
 * rather than something the next read does silently - which is exactly what the
 * seed marker exists to guarantee (D116/D127).
 *
 * It calls the RESTORE op rather than saving a client-built list: only the host
 * can build the seed a first read would have produced, and a list assembled here
 * would be a second opinion about what the defaults are.
 */
function EmptyGroups(props: {
  readonly onRestoreDefaults: () => void;
  readonly restorePending: boolean;
}): ReactNode {
  const { onRestoreDefaults, restorePending } = props;
  return (
    <div
      className="mt-3 rounded-lg border border-dashed border-border/70 px-4 py-5"
      data-testid="fallback-tier-groups-empty"
    >
      <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
        No model groups, so the &ldquo;equivalent model&rdquo; step has nothing
        to switch to. Add a group, or put the defaults back.
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-3 h-8"
        disabled={restorePending}
        onClick={onRestoreDefaults}
      >
        Restore the default groups
        {restorePending ? (
          <AgentSpinningDots
            className="ml-2"
            testId={undefined}
            variant="orbit"
          />
        ) : null}
      </Button>
    </div>
  );
}

function previewForGroup(
  preview: readonly TierCandidatePreview[] | null,
  groupId: string,
): readonly TierCandidatePreview[] | null {
  if (preview === null) return null;
  return preview.filter((row) => row.groupId === groupId);
}

/**
 * A harness to seed a new row in a group that has none.
 *
 * Taken from the user's own existing groups rather than from the harness
 * catalog: a harness already in their configuration is one they have, which is
 * a better guess than the first entry of a list they may not have installed -
 * and it needs no catalog read on a settings page that otherwise needs none.
 *
 * Never `null`. An earlier draft returned one and disabled "Add a model", which
 * made a group whose rows had all been removed a dead end the user could reach
 * by ordinary editing. The row carries its own provider select, so the seed is
 * only ever a starting point.
 */
function firstHarnessId(
  groups: readonly KeyedGroup[],
): TierCandidate["harnessId"] {
  for (const group of groups) {
    if (group.candidates.length > 0) return group.candidates[0].value.harnessId;
  }
  return SEED_HARNESS_ID;
}

/**
 * A distinct name for a new group.
 *
 * Group ids must be unique or the whole policy fails validation, so a fixed
 * "New group" would make the second one invalid the moment it is added - the
 * user would meet an error they did not cause and could not have avoided.
 */
function nextGroupName(groups: readonly KeyedGroup[]): string {
  const taken = new Set(groups.map((group) => group.id));
  if (!taken.has("New group")) return "New group";
  let suffix = 2;
  while (taken.has(`New group ${suffix}`)) suffix += 1;
  return `New group ${suffix}`;
}
