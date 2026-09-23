/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Rules).
 * Update that file whenever this settings surface changes.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TriangleAlert } from "lucide-react";
import type {
  AutoPolicyGetResponse,
  AutoPolicyReadState,
} from "@traycer/protocol/host/auto-mode/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useAutoPolicyQuery } from "@/hooks/auto-mode/use-auto-policy-query";
import { useAutoPolicySetMutation } from "@/hooks/auto-mode/use-auto-policy-set-mutation";
import {
  AUTO_POLICY_MAX_BYTES,
  EMPTY_AUTO_POLICY_SECTIONS,
  appendAutoPolicyLine,
  autoPolicyByteLength,
  autoPolicyChangedSinceLoad,
  autoPolicyNeedsReorder,
  autoPolicyReadStateFor,
  joinAutoPolicySections,
  splitAutoPolicySections,
  type AutoPolicyOpeningRead,
  type AutoPolicySectionKey,
  type AutoPolicySections,
  type PendingRuleDraft,
} from "@/components/settings/panels/auto-policy-document";
import {
  hasShippedAutoPolicySections,
  parseShippedAutoPolicy,
  parseShippedAutoPolicyRules,
  type ShippedAutoPolicySections,
} from "@/components/settings/panels/auto-policy-shipped-document";
import {
  AutoModeHostGate,
  AutoModeUnsupportedLine,
} from "@/components/settings/panels/permissions/auto-mode-host-gate";
import { autoModeRuleDisplayName } from "@/lib/auto-mode/auto-mode-rule-copy";
import { useRelativeTimestamp } from "@/lib/relative-time";

type RulesSectionKey = AutoPolicySectionKey | "notes";

interface RulesSectionCopy {
  readonly label: string;
  /** The one-line promise beside the label, or `null` for none. */
  readonly tagline: string | null;
  readonly description: string;
  readonly placeholder: string;
  /** Which shipped tier this section extends, or `null` for none. */
  readonly builtIn: keyof ShippedAutoPolicySections | null;
}

/**
 * The tab's names for the four sections the host parses. The STORAGE headings
 * stay `Environment` / `Allow` / `Soft deny` / `Hard deny`
 * (`joinAutoPolicySections`); these say what happens to the user instead.
 */
const RULES_SECTION_COPY: Readonly<Record<RulesSectionKey, RulesSectionCopy>> =
  {
    environment: {
      label: "Environment",
      tagline: "What the judge should trust",
      description:
        "Your repos, hosts, buckets and internal services, in plain words.",
      placeholder:
        "Source control: github.com/acme and every repo under it\nInternal registry: npm.acme.internal\nStaging cluster: k8s-staging (safe to deploy to)",
      builtIn: null,
    },
    allow: {
      label: "Always allow",
      tagline: "Approve without asking",
      description:
        "Routine actions a built-in rule would otherwise ask about. Name the repository or branch to keep a rule narrow.",
      placeholder:
        "In github.com/acme/web: deploying to the staging namespace (isolated, resets nightly)",
      builtIn: "allowExceptions",
    },
    softDeny: {
      label: "Ask first",
      tagline: "Send to you, unless you asked for exactly that",
      description: "Destructive or hard-to-undo actions that need your say-so.",
      placeholder:
        "Database migrations outside the migrations CLI, even on dev databases",
      builtIn: "softBlock",
    },
    hardDeny: {
      label: "Never allow",
      tagline: "Always send to you, whatever the conversation says",
      description:
        "Security boundaries. You can still approve on the card; the judge never will.",
      placeholder:
        "Sending repository contents to third-party code-review APIs",
      builtIn: "hardBlock",
    },
    notes: {
      label: "Notes",
      tagline: null,
      description:
        "Text that isn't under any of the four sections. The judge reads it as written.",
      placeholder: "",
      builtIn: null,
    },
  };

const RULES_SECTION_ORDER: ReadonlyArray<RulesSectionKey> = [
  "environment",
  "allow",
  "softDeny",
  "hardDeny",
  "notes",
];

const PREDATES_AUTO_MODE =
  "This machine's host predates Auto mode. Update it to choose a judge and write a policy.";

/**
 * Settings ▸ Permissions ▸ Rules: the account's Auto mode policy, edited in
 * place as four sections (plus Notes when the stored document has any), each
 * beside the built-in rules it extends.
 *
 * Save is explicit, and the record is ACCOUNT-wide and last-write-wins, so the
 * stale-write protection the old editor dialog carried is kept whole: an
 * opening read each time the tab is shown, a compare of the record's
 * `updatedAt` against the one the edit started from, and Save held off while
 * the record is unreadable, stale, unwritable or unchecked.
 */
export function RulesTab(props: {
  /** Whether the tab is the one on screen; each showing re-reads the record. */
  readonly active: boolean;
  readonly drafts: ReadonlyArray<PendingRuleDraft>;
  /** Called once the editor has taken every draft up to `throughId`. */
  readonly onDraftsConsumed: (throughId: number) => void;
  /**
   * The edit as the page last saw it, or `null` before there is one. A
   * remounted editor - a switch of machine re-keys everything under
   * `HostScopeGate` - starts from it, so the edit follows the account, not the
   * machine that happened to be showing it.
   */
  readonly snapshot: RulesEditorState | null;
  /** Hands every committed editor state up to the page. */
  readonly onSnapshot: (editor: RulesEditorState) => void;
}): ReactNode {
  return (
    <AutoModeHostGate
      method="autoPolicy.get"
      unsupported={
        <AutoModeUnsupportedLine>{PREDATES_AUTO_MODE}</AutoModeUnsupportedLine>
      }
    >
      {(hostId) => (
        <RulesEditor
          hostId={hostId}
          active={props.active}
          drafts={props.drafts}
          onDraftsConsumed={props.onDraftsConsumed}
          snapshot={props.snapshot}
          onSnapshot={props.onSnapshot}
        />
      )}
    </AutoModeHostGate>
  );
}

/**
 * What the editor holds between renders. `baseline` is the record the edit
 * started from and `sections` the edit itself; everything else is bookkeeping
 * for the gates and the drafts. The page keeps a copy (see `RulesTab`'s
 * `snapshot`), so it is exported.
 */
export interface RulesEditorState {
  /** Which record `baseline` came from; a newer one re-seeds a clean editor. */
  readonly recordKey: string;
  readonly readState: AutoPolicyReadState;
  readonly baseline: AutoPolicySections;
  readonly sections: AutoPolicySections;
  /** `updatedAt` as it read when this edit started; see the stale warning. */
  readonly loadedUpdatedAt: string | null;
  /** The stored text is not in canonical form, so a save will reorder it. */
  readonly reorders: boolean;
  /** Sections a draft landed in during this edit. */
  readonly drafted: ReadonlyArray<AutoPolicySectionKey>;
  readonly appliedDraftId: number;
  readonly scrollRequest: {
    readonly section: AutoPolicySectionKey;
    readonly nonce: number;
  } | null;
}

function recordKeyFor(
  body: string | null,
  updatedAt: string | null,
  readState: AutoPolicyReadState,
): string {
  return JSON.stringify([body, updatedAt, readState]);
}

function editorFromRecord(input: {
  readonly body: string | null;
  readonly updatedAt: string | null;
  readonly readState: AutoPolicyReadState;
  readonly appliedDraftId: number;
}): RulesEditorState {
  const { body, updatedAt, readState } = input;
  // An unreadable record's `null` body is evidence of nothing, so the editor
  // shows no text for it rather than an empty policy it could save over.
  const baseline =
    readState === "unreadable"
      ? EMPTY_AUTO_POLICY_SECTIONS
      : splitAutoPolicySections(body ?? "");
  return {
    recordKey: recordKeyFor(body, updatedAt, readState),
    readState,
    baseline,
    sections: baseline,
    loadedUpdatedAt: updatedAt,
    reorders: readState !== "unreadable" && autoPolicyNeedsReorder(body ?? ""),
    drafted: [],
    appliedDraftId: input.appliedDraftId,
    scrollRequest: null,
  };
}

function editorIsDirty(editor: RulesEditorState): boolean {
  return (
    joinAutoPolicySections(editor.sections) !==
    joinAutoPolicySections(editor.baseline)
  );
}

/**
 * Whether a newer record already says exactly what the edit says, so there is
 * nothing left to save. The save's own answer re-seeds a mounted editor; this
 * is the same re-seed for an editor that did not see that answer - one resumed
 * on another machine while its save was in flight, whose opening read there
 * returns the saved record. A dirty edit is otherwise never re-seeded, and the
 * user's own save would read as a change made elsewhere.
 */
function editorHoldsRecord(
  editor: RulesEditorState,
  body: string | null,
  readState: AutoPolicyReadState,
): boolean {
  if (readState === "unreadable") return false;
  return (
    joinAutoPolicySections(editor.sections) ===
    joinAutoPolicySections(splitAutoPolicySections(body ?? ""))
  );
}

/**
 * Every draft newer than the last one applied, appended to its section in
 * arrival order - whether or not the edit is already dirty, and below an
 * earlier draft still unsaved. The same object when there is nothing new, so
 * the render-phase adjustment below settles.
 */
function editorWithDrafts(
  editor: RulesEditorState,
  drafts: ReadonlyArray<PendingRuleDraft>,
): RulesEditorState {
  const pending = drafts.filter((entry) => entry.id > editor.appliedDraftId);
  const last = pending.at(-1);
  if (last === undefined) return editor;
  let sections = editor.sections;
  const drafted = new Set(editor.drafted);
  for (const entry of pending) {
    const key = entry.draft.section;
    sections = {
      ...sections,
      [key]: appendAutoPolicyLine(sections[key], entry.draft.text),
    };
    drafted.add(key);
  }
  return {
    ...editor,
    sections,
    drafted: [...drafted],
    appliedDraftId: last.id,
    scrollRequest: { section: last.draft.section, nonce: last.id },
  };
}

/**
 * The editor state for this render: the record seeds it the first time and
 * re-seeds it whenever a newer record arrives while the edit is clean - or
 * already says exactly what that record says - and pending drafts are
 * appended once the record is known.
 *
 * Drafts wait while a save is in flight, so the save's own re-seed cannot
 * swallow one, and while the record is unreadable, where there is no text to
 * append to.
 */
function nextEditorState(input: {
  readonly editor: RulesEditorState | null;
  readonly data: AutoPolicyGetResponse | undefined;
  readonly drafts: ReadonlyArray<PendingRuleDraft>;
  readonly saving: boolean;
}): RulesEditorState | null {
  const { data } = input;
  let editor = input.editor;
  if (data === undefined) return editor;
  const readState = autoPolicyReadStateFor(data);
  const key = recordKeyFor(data.body, data.updatedAt, readState);
  if (
    editor === null ||
    (editor.recordKey !== key &&
      (!editorIsDirty(editor) ||
        editorHoldsRecord(editor, data.body, readState)))
  ) {
    editor = editorFromRecord({
      body: data.body,
      updatedAt: data.updatedAt,
      readState,
      appliedDraftId: editor?.appliedDraftId ?? 0,
    });
  }
  if (input.saving || readState === "unreadable") return editor;
  return editorWithDrafts(editor, input.drafts);
}

/** The last draft nonce an editor state has already scrolled to, or `0`. */
function scrolledThrough(editor: RulesEditorState | null): number {
  return editor?.scrollRequest?.nonce ?? 0;
}

function RulesEditor(props: {
  readonly hostId: string | null;
  readonly active: boolean;
  readonly drafts: ReadonlyArray<PendingRuleDraft>;
  readonly onDraftsConsumed: (throughId: number) => void;
  readonly snapshot: RulesEditorState | null;
  readonly onSnapshot: (editor: RulesEditorState) => void;
}): ReactNode {
  const query = useAutoPolicyQuery();
  const setPolicy = useAutoPolicySetMutation();
  // The row is mounted on `autoPolicy.get`, and `autoPolicy.set` is its own
  // optional method. The BOOLEAN form is safe here: the tab only exists because
  // the getter answered `true`, so a manifest for this host is recorded.
  const canWrite = useHostSupportsMethod(props.hostId, "autoPolicy.set");
  const data = query.data;
  const shipped = useMemo(
    () => parseShippedAutoPolicy(data?.shippedDefaults ?? ""),
    [data?.shippedDefaults],
  );
  // Local and authoritative while mounted; seeded from the page's copy, so a
  // remount (another machine, the same account) resumes the same edit. The
  // opening read below is this mount's own, so it is re-taken on the machine
  // now showing, and the banner governs Save exactly as for a fresh edit.
  const [editorState, setEditorState] = useState<RulesEditorState | null>(
    props.snapshot,
  );
  const editor = nextEditorState({
    editor: editorState,
    data,
    drafts: props.drafts,
    saving: setPolicy.isPending,
  });
  if (editor !== editorState) setEditorState(editor);
  const openingRead = useOpeningRead(props.active, query.refetch);

  const appliedDraftId = editor?.appliedDraftId ?? 0;
  const { onDraftsConsumed, onSnapshot } = props;
  useEffect(() => {
    if (appliedDraftId > 0) onDraftsConsumed(appliedDraftId);
  }, [appliedDraftId, onDraftsConsumed]);
  useEffect(() => {
    if (editorState !== null) onSnapshot(editorState);
  }, [editorState, onSnapshot]);

  const sectionRefs = useRef(new Map<AutoPolicySectionKey, HTMLElement>());
  // A draft scrolls its section into view once. A remount resumes a snapshot
  // whose last draft has already been shown, so it starts past that one.
  const scrolledNonce = useRef(scrolledThrough(props.snapshot));
  const scrollRequest = editor?.scrollRequest ?? null;
  useEffect(() => {
    if (scrollRequest === null) return;
    if (scrollRequest.nonce <= scrolledNonce.current) return;
    scrolledNonce.current = scrollRequest.nonce;
    const element = sectionRefs.current.get(scrollRequest.section);
    element?.scrollIntoView({ block: "center" });
  }, [scrollRequest]);

  if (editor === null) {
    return query.isError ? (
      <p className="px-1 text-ui-sm text-warning-foreground">
        Couldn&apos;t read your rules. Reopen Settings to try again.
      </p>
    ) : null;
  }

  const saving = setPolicy.isPending;
  const commit = (): void => {
    const body = joinAutoPolicySections(editor.sections);
    setPolicy.mutate(
      { body },
      {
        onSuccess: (response) => {
          setEditorState((current) =>
            editorFromRecord({
              body,
              updatedAt: response.updatedAt,
              readState: "fresh",
              appliedDraftId: current?.appliedDraftId ?? 0,
            }),
          );
        },
      },
    );
  };
  const discard = (): void => {
    if (data === undefined) return;
    setEditorState(
      editorFromRecord({
        body: data.body,
        updatedAt: data.updatedAt,
        readState: autoPolicyReadStateFor(data),
        appliedDraftId: editor.appliedDraftId,
      }),
    );
  };
  // The LIVE record's state gates Save, not the one the edit started from: a
  // read that turns unreadable or stale behind a dirty edit must stop a save
  // over a policy this window can no longer see.
  const readState =
    data === undefined ? editor.readState : autoPolicyReadStateFor(data);
  const showNotes =
    editor.baseline.notes.length > 0 || editor.sections.notes.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-ui-sm text-muted-foreground">
        Your rules go on top of Traycer&apos;s built-in ones and apply to your
        account on every machine. A repository with{" "}
        <code className="font-mono">.traycer/auto-policy.md</code> adds its own
        restrictions on top.
      </p>
      <RulesBanner
        readState={readState}
        canWrite={canWrite}
        openingRead={openingRead}
        changedSinceLoad={autoPolicyChangedSinceLoad(
          editor.loadedUpdatedAt,
          data?.updatedAt ?? null,
        )}
      />
      {editor.reorders ? (
        <p
          className="px-1 text-ui-xs text-muted-foreground"
          data-testid="auto-policy-reorder-notice"
        >
          Saved in Traycer&apos;s section order.
        </p>
      ) : null}
      {RULES_SECTION_ORDER.map((key) =>
        key === "notes" && !showNotes ? null : (
          <RulesSection
            key={key}
            sectionKey={key}
            value={editor.sections[key]}
            drafted={key !== "notes" && editor.drafted.includes(key)}
            // An unreadable record has no text to edit; a save in flight
            // captured the text at the click, and typing after it would be
            // silently dropped by the re-seed.
            disabled={saving || editor.readState === "unreadable"}
            shipped={shipped}
            onElement={(element) => {
              if (key === "notes") return;
              if (element === null) sectionRefs.current.delete(key);
              else sectionRefs.current.set(key, element);
            }}
            onChange={(next) => {
              setEditorState((current) =>
                current === null
                  ? current
                  : {
                      ...current,
                      sections: { ...current.sections, [key]: next },
                    },
              );
            }}
          />
        ),
      )}
      {hasShippedAutoPolicySections(shipped) ? (
        <p className="px-1 text-ui-xs text-muted-foreground">
          Built-in rules come with each machine&apos;s Traycer version.
        </p>
      ) : null}
      <RulesFooter
        editor={editor}
        readState={readState}
        record={data}
        canWrite={canWrite}
        openingRead={openingRead}
        saving={saving}
        onDiscard={discard}
        onSave={commit}
      />
    </div>
  );
}

/**
 * The read that answers "has anyone else saved since?" for this showing of the
 * tab.
 *
 * Each time the tab comes on screen the record is re-read, and Save waits for
 * that answer: a save committed before it lands compares `updatedAt` against
 * the cached value the edit was seeded from, finds them equal, and silently
 * replaces a newer policy from another device. A FAILED read keeps Save off
 * too, with its own sentence - allowing the save because it could not be
 * checked is exactly the blind overwrite this exists to stop.
 *
 * `cancelRefetch: false` joins the read the query's own mount refetch already
 * started rather than cancelling and repeating it. The generation stops an
 * earlier showing's late answer from unlocking Save for a later one.
 */
function useOpeningRead(
  active: boolean,
  refetch: (options: {
    readonly cancelRefetch: boolean;
  }) => Promise<{ readonly isError: boolean }>,
): AutoPolicyOpeningRead {
  const [round, setRound] = useState<{
    readonly active: boolean;
    readonly generation: number;
    readonly state: AutoPolicyOpeningRead;
  }>({
    active,
    generation: active ? 1 : 0,
    state: active ? "pending" : "settled",
  });
  if (round.active !== active) {
    setRound({
      active,
      generation: active ? round.generation + 1 : round.generation,
      state: active ? "pending" : round.state,
    });
  }
  const generation = round.generation;
  useEffect(() => {
    if (generation === 0) return;
    let cancelled = false;
    const settle = (state: AutoPolicyOpeningRead): void => {
      if (cancelled) return;
      setRound((current) =>
        current.generation === generation ? { ...current, state } : current,
      );
    };
    // `refetch()` resolves with an error RESULT rather than rejecting unless
    // the query throws on error, so the first arm is the one that runs; the
    // rejection arm is there because that is a query option, not a contract.
    refetch({ cancelRefetch: false }).then(
      (result) => settle(result.isError ? "failed" : "settled"),
      () => settle("failed"),
    );
    return () => {
      cancelled = true;
    };
  }, [generation, refetch]);
  return round.state;
}

const BANNER_CLASSNAME =
  "flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground";

/**
 * Everything the tab has to say about the RECORD: one banner, one sentence per
 * cause, and the causes are not exclusive - a read can be unreadable AND the
 * host unable to save, and a user owed both reasons gets both. Four of them
 * turn Save off; the last only warns, because saving over another device's
 * newer version is a choice the user can make once told.
 */
function RulesBanner(props: {
  readonly readState: AutoPolicyReadState;
  readonly canWrite: boolean;
  readonly openingRead: AutoPolicyOpeningRead;
  readonly changedSinceLoad: boolean;
}): ReactNode {
  const sentences = [
    props.readState === "unreadable"
      ? "Traycer can't read your saved rules right now, so saving is off. Reopen Settings to try again."
      : null,
    props.readState === "stale"
      ? "Traycer is showing a copy of your rules it couldn't refresh, so saving is off. Reopen Settings to try again."
      : null,
    props.canWrite
      ? null
      : "This machine's host can't save rules, so saving is off. Update it to make changes.",
    props.openingRead === "failed"
      ? "Traycer couldn't check whether another device changed your rules, so saving is off. Reopen Settings to try again."
      : null,
    props.changedSinceLoad
      ? "Your rules were saved somewhere else since you started editing. Saving now replaces that version."
      : null,
  ].filter((sentence) => sentence !== null);
  if (sentences.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="auto-policy-banner"
      className={BANNER_CLASSNAME}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{sentences.join(" ")}</span>
    </div>
  );
}

// `onElement` is taken out of `props` because it is handed to `ref`: React's
// refs rule would otherwise treat the whole props object as a ref.
function RulesSection({
  onElement,
  ...props
}: {
  readonly sectionKey: RulesSectionKey;
  readonly value: string;
  readonly drafted: boolean;
  readonly disabled: boolean;
  readonly shipped: ShippedAutoPolicySections;
  /** The section's element, for scrolling a drafted rule into view. */
  readonly onElement: (element: HTMLElement | null) => void;
  readonly onChange: (next: string) => void;
}): ReactNode {
  const copy = RULES_SECTION_COPY[props.sectionKey];
  const fieldId = useId();
  const descriptionId = useId();
  return (
    <section
      ref={onElement}
      className="flex flex-col gap-1.5"
      data-testid={`auto-policy-section-${props.sectionKey}`}
    >
      {props.drafted ? (
        <p className="px-1 text-ui-xs text-info-foreground">
          Applies to every repository on your account. Keep it specific.
        </p>
      ) : null}
      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <label htmlFor={fieldId} className="font-medium text-foreground">
            {copy.label}
          </label>
          {copy.tagline === null ? null : (
            <span className="text-ui-xs text-muted-foreground">
              {copy.tagline}
            </span>
          )}
        </div>
        <p id={descriptionId} className="text-ui-sm text-muted-foreground">
          {copy.description}
        </p>
        <Textarea
          id={fieldId}
          aria-describedby={descriptionId}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          disabled={props.disabled}
          placeholder={copy.placeholder}
          spellCheck={false}
          font="mono"
          // The code scale: a long-form mono document that follows
          // Appearance ▸ Code font size, like the markdown editor.
          size="code"
          data-testid={`auto-policy-input-${props.sectionKey}`}
        />
        {copy.builtIn === null ? null : (
          <BuiltInRules
            body={props.shipped[copy.builtIn]}
            alwaysOn={copy.builtIn === "hardBlock"}
          />
        )}
      </div>
    </section>
  );
}

/**
 * The shipped rules a section extends, as chips from the shipped document's
 * bold rule names; a chip expands to that rule's text. Never allow's list is
 * open by default and says it is always on, because those rules apply whatever
 * the user writes.
 */
function BuiltInRules(props: {
  readonly body: string;
  readonly alwaysOn: boolean;
}): ReactNode {
  const rules = useMemo(
    () => parseShippedAutoPolicyRules(props.body),
    [props.body],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  if (rules.length === 0) return null;
  const count = `Built-in: ${rules.length} ${rules.length === 1 ? "rule" : "rules"}`;
  const expandedRule = rules.find((rule) => rule.name === expanded) ?? null;
  return (
    <Collapsible defaultOpen={props.alwaysOn} className="text-ui-xs">
      <CollapsibleTrigger variant="quiet">
        {props.alwaysOn ? `${count}, always on` : count}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-1">
        <ul className="flex flex-wrap gap-1.5">
          {rules.map((rule) => (
            <li key={rule.name}>
              <Button
                type="button"
                variant="muted-outline"
                size="xs"
                aria-expanded={expanded === rule.name}
                onClick={() =>
                  setExpanded((current) =>
                    current === rule.name ? null : rule.name,
                  )
                }
              >
                {autoModeRuleDisplayName(rule.name)}
              </Button>
            </li>
          ))}
        </ul>
        {expandedRule === null ? null : (
          <p className="whitespace-pre-line text-ui-xs text-muted-foreground">
            {expandedRule.text}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The sticky footer: what is stored (or, when the draft is over the server's
 * cap, by how much), and the two actions. Save's pending affordance serves
 * both waits - the write and the opening read - because both say the same
 * thing to the user: Save is busy, not broken.
 */
function RulesFooter(props: {
  readonly editor: RulesEditorState;
  readonly readState: AutoPolicyReadState;
  readonly record: AutoPolicyGetResponse | undefined;
  readonly canWrite: boolean;
  readonly openingRead: AutoPolicyOpeningRead;
  readonly saving: boolean;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}): ReactNode {
  const { editor, saving } = props;
  const dirty = editorIsDirty(editor);
  const bytes = autoPolicyByteLength(joinAutoPolicySections(editor.sections));
  const overCap = bytes > AUTO_POLICY_MAX_BYTES;
  const checking = props.openingRead === "pending";
  const saveBlocked =
    props.readState !== "fresh" ||
    !props.canWrite ||
    props.openingRead !== "settled";
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background py-3">
      {overCap ? (
        <span className="text-ui-xs text-destructive">
          {`Too long by ${(bytes - AUTO_POLICY_MAX_BYTES).toLocaleString()} bytes - the limit is ${AUTO_POLICY_MAX_BYTES.toLocaleString()}.`}
        </span>
      ) : (
        <AutoPolicySummary record={props.record} />
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving || !dirty}
          onClick={props.onDiscard}
          data-testid="auto-policy-discard"
        >
          Discard
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={saving || checking || !dirty || overCap || saveBlocked}
          onClick={props.onSave}
          data-testid="auto-policy-save"
        >
          {saving || checking ? (
            <AgentSpinningDots
              className={undefined}
              testId="auto-policy-saving-spinner"
              variant={undefined}
            />
          ) : null}
          Save rules
        </Button>
      </div>
    </div>
  );
}

/**
 * What the footer says about the stored RECORD, not the edit.
 *
 * `readState` is consulted BEFORE `body`: on an unreadable read `body: null` is
 * evidence of nothing, and "Not set" would assert a policy does not exist
 * because the host could not look. A STALE read with no body cannot say "Not
 * set" either - it is the absence the host cached, not the account's state
 * now. `updatedAt: null` with a body is a cached copy, so it says "Set" and
 * invents no date.
 */
function AutoPolicySummary(props: {
  readonly record: AutoPolicyGetResponse | undefined;
}): ReactNode {
  const { record } = props;
  if (record === undefined) return <span />;
  const readState = autoPolicyReadStateFor(record);
  const quiet = "text-ui-xs text-muted-foreground";
  const warn = "font-medium text-ui-xs text-warning-foreground";
  if (readState === "unreadable") {
    return <span className={warn}>Couldn&apos;t read your rules</span>;
  }
  const body = record.body;
  if (body === null || body.length === 0) {
    return readState === "stale" ? (
      <span className={warn}>Couldn&apos;t check your rules</span>
    ) : (
      <span className={quiet}>Not set</span>
    );
  }
  // Parsed here, so the component below only ever mounts with a real instant.
  const savedAt =
    record.updatedAt === null ? Number.NaN : Date.parse(record.updatedAt);
  if (Number.isNaN(savedAt)) return <span className={quiet}>Set</span>;
  return <AutoPolicySavedAt savedAt={savedAt} className={quiet} />;
}

function AutoPolicySavedAt(props: {
  readonly savedAt: number;
  readonly className: string;
}): ReactNode {
  // The shared 60s tick, so "Saved 2 minutes ago" ages without a refetch.
  const relative = useRelativeTimestamp(props.savedAt);
  return <span className={props.className}>Saved {relative}</span>;
}
