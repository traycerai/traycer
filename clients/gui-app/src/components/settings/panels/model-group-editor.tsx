/**
 * Visual model group editor — pick providers/models from the live harness
 * catalog instead of editing raw JSON.
 *
 * Data flow: load via `orchestrationGroupShow` (CLI bridge), edit a local
 * draft, save via `orchestrationGroupSave`. Model choices come from
 * `useGuiHarnessCatalog` (the same catalog the composer picker uses).
 */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useGuiHarnessCatalog,
  type GuiHarnessCatalog,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useRunnerOrchestrationGroupSaveMutation } from "@/hooks/runner/use-runner-orchestration-queries";
import { useRunnerHost } from "@/providers/use-runner-host";
import { cn } from "@/lib/utils";
import type {
  TraycerModelEntry,
  TraycerModelGroup,
  TraycerModelTier,
} from "@traycer-clients/shared/platform/runner-host";

const TIER_ORDER: readonly string[] = ["premium", "executor", "economic"];

const INPUT_CLASS =
  "w-full rounded-md border border-border/40 bg-background px-2 py-1 text-ui-xs";

/** Best-effort family guess from the model slug, then the harness id. */
function deriveFamily(harnessId: string, slug: string): string {
  const s = slug.toLowerCase();
  if (s.includes("kimi")) return "kimi";
  if (s.includes("claude")) return "claude";
  if (s.includes("gpt")) return "openai";
  if (s.includes("grok")) return "xai";
  if (s.includes("glm")) return "glm";
  if (s.includes("qwen")) return "qwen";
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("minimax")) return "minimax";
  if (s.includes("muse")) return "muse";
  return harnessId;
}

interface RuleRow {
  readonly id: string;
  readonly text: string;
}

interface ModelDraft {
  readonly harnessId: string;
  readonly slug: string;
  readonly effort: string | null;
}

export function ModelGroupEditor(props: {
  readonly groupName: string;
  readonly onClose: () => void;
}) {
  const runnerHost = useRunnerHost();
  const saveMutation = useRunnerOrchestrationGroupSaveMutation();
  const catalog = useGuiHarnessCatalog(null, {
    enabled: true,
    subscribed: true,
  });

  const [group, setGroup] = useState<TraycerModelGroup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load once on mount.
  const traycerCli = runnerHost.traycerCli;
  if (group === null && loadError === null && traycerCli !== null) {
    traycerCli
      .orchestrationGroupShow({ name: props.groupName })
      .then((loaded) => {
        if (loaded === null) {
          setLoadError("Group not found.");
          return;
        }
        setGroup(loaded);
      })
      .catch(() => setLoadError("Failed to load group."));
  }

  const tierNames = useMemo(() => {
    if (group === null) return [];
    const known = TIER_ORDER.filter((t) => t in group.tiers);
    const extra = Object.keys(group.tiers).filter(
      (t) => !TIER_ORDER.includes(t),
    );
    return [...known, ...extra];
  }, [group]);

  if (loadError !== null) {
    return (
      <p className="text-ui-sm text-destructive">
        {loadError}{" "}
        <button onClick={props.onClose} className="underline">
          Close
        </button>
      </p>
    );
  }
  if (group === null) {
    return <p className="text-ui-sm text-muted-foreground">Loading group…</p>;
  }

  const patchTier = (tierName: string, tier: TraycerModelTier) => {
    setGroup({ ...group, tiers: { ...group.tiers, [tierName]: tier } });
  };

  const handleSave = () => {
    saveMutation.mutate(
      { name: props.groupName, group },
      { onSuccess: () => props.onClose() },
    );
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-ui-base font-medium">
            Edit model group: {group.name}
          </h3>
          <p className="text-ui-xs text-muted-foreground">
            Rotation order matters — the first model is tried first, the rest
            are fallbacks.
          </p>
        </div>
        <button
          onClick={props.onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Close editor"
        >
          <X className="size-4" />
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-ui-xs font-medium text-muted-foreground">
          Description
        </span>
        <input
          value={group.description}
          onChange={(e) => setGroup({ ...group, description: e.target.value })}
          className={INPUT_CLASS}
        />
      </label>

      <RulesEditor
        rules={group.rules}
        onChange={(rules) => setGroup({ ...group, rules })}
      />

      {tierNames.map((tierName) => (
        <TierSection
          key={tierName}
          tierName={tierName}
          tier={group.tiers[tierName]}
          catalog={catalog}
          onChange={(tier) => patchTier(tierName, tier)}
        />
      ))}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? "Saving…" : "Save group"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        {saveMutation.isError ? (
          <span className="text-ui-xs text-destructive">
            Save failed — check the CLI.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Rules ──────────────────────────────────────────────────────────────────

function RulesEditor(props: {
  readonly rules: readonly string[];
  readonly onChange: (rules: readonly string[]) => void;
}) {
  // Rows carry stable ids for React keys; text syncs out on every edit.
  const [rows, setRows] = useState<readonly RuleRow[]>(() =>
    props.rules.map((text) => ({ id: crypto.randomUUID(), text })),
  );

  const sync = (next: readonly RuleRow[]) => {
    setRows(next);
    props.onChange(next.map((r) => r.text));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui-xs font-medium text-muted-foreground">
        Rules ({rows.length})
      </span>
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-1">
          <input
            value={row.text}
            onChange={(e) =>
              sync(
                rows.map((r) =>
                  r.id === row.id ? { ...r, text: e.target.value } : r,
                ),
              )
            }
            className={INPUT_CLASS}
          />
          <button
            onClick={() => sync(rows.filter((r) => r.id !== row.id))}
            className="rounded p-1 text-muted-foreground hover:text-destructive"
            aria-label="Remove rule"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start text-ui-xs"
        onClick={() => sync([...rows, { id: crypto.randomUUID(), text: "" }])}
      >
        <Plus className="mr-1 size-3" /> Add rule
      </Button>
    </div>
  );
}

// ─── Tier section ───────────────────────────────────────────────────────────

function TierSection(props: {
  readonly tierName: string;
  readonly tier: TraycerModelTier;
  readonly catalog: GuiHarnessCatalog;
  readonly onChange: (tier: TraycerModelTier) => void;
}) {
  const { tier } = props;
  const [adding, setAdding] = useState(false);

  const patchModels = (models: readonly TraycerModelEntry[]) =>
    props.onChange({ ...tier, models });

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= tier.models.length) return;
    const next = [...tier.models];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    patchModels(next);
  };

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/40 p-3">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-ui-xs">
          {props.tierName}
        </Badge>
        <input
          value={tier.description}
          onChange={(e) =>
            props.onChange({ ...tier, description: e.target.value })
          }
          placeholder="Tier description"
          className={cn(INPUT_CLASS, "flex-1")}
        />
      </div>

      {tier.models.length === 0 ? (
        <p className="text-ui-xs text-muted-foreground">
          No models in this tier.
        </p>
      ) : (
        tier.models.map((entry, i) => (
          <ModelRow
            key={`${entry.harnessId}/${entry.model}`}
            entry={entry}
            index={i}
            isFirst={i === 0}
            isLast={i === tier.models.length - 1}
            catalog={props.catalog}
            onMove={(delta) => move(i, delta)}
            onChange={(updated) =>
              patchModels(tier.models.map((m, j) => (j === i ? updated : m)))
            }
            onRemove={() => patchModels(tier.models.filter((_, j) => j !== i))}
          />
        ))
      )}

      {adding ? (
        <AddModelRow
          catalog={props.catalog}
          existingKeys={tier.models.map((m) => `${m.harnessId}/${m.model}`)}
          onAdd={(entry) => {
            patchModels([...tier.models, entry]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="self-start text-ui-xs"
          onClick={() => setAdding(true)}
        >
          <Plus className="mr-1 size-3" /> Add model
        </Button>
      )}
    </section>
  );
}

// ─── Model row ──────────────────────────────────────────────────────────────

function ModelRow(props: {
  readonly entry: TraycerModelEntry;
  readonly index: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly catalog: GuiHarnessCatalog;
  readonly onMove: (delta: number) => void;
  readonly onChange: (entry: TraycerModelEntry) => void;
  readonly onRemove: () => void;
}) {
  const { entry } = props;
  const catalogModel = useMemo(() => {
    for (const harness of props.catalog.harnesses) {
      if (harness.id !== entry.harnessId) continue;
      const found = harness.models.find((m) => m.slug === entry.model);
      if (found !== undefined) return found;
    }
    return null;
  }, [props.catalog.harnesses, entry.harnessId, entry.model]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/30 bg-card/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-ui-xs text-muted-foreground">
          {props.index + 1}.
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-xs font-medium">
          {catalogModel?.label ?? entry.model}
        </span>
        <span className="text-ui-xs text-muted-foreground">
          {entry.harnessId}
        </span>
        <button
          onClick={() => props.onMove(-1)}
          disabled={props.isFirst}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label="Move up"
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          onClick={() => props.onMove(1)}
          disabled={props.isLast}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
          aria-label="Move down"
        >
          <ArrowDown className="size-3" />
        </button>
        <button
          onClick={props.onRemove}
          className="rounded p-0.5 text-muted-foreground hover:text-destructive"
          aria-label="Remove model"
        >
          <X className="size-3" />
        </button>
      </div>
      <ModelRowFields
        entry={entry}
        effortOptions={catalogModel?.supportedReasoningEfforts ?? []}
        onChange={props.onChange}
      />
    </div>
  );
}

function ModelRowFields(props: {
  readonly entry: TraycerModelEntry;
  readonly effortOptions: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly onChange: (entry: TraycerModelEntry) => void;
}) {
  const { entry } = props;
  return (
    <div className="flex items-center gap-1.5">
      {props.effortOptions.length > 0 ? (
        <select
          value={entry.effort ?? ""}
          onChange={(e) =>
            props.onChange({
              ...entry,
              effort: e.target.value === "" ? null : e.target.value,
            })
          }
          className={cn(INPUT_CLASS, "w-28")}
        >
          <option value="">(no effort)</option>
          {props.effortOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={entry.effort ?? ""}
          onChange={(e) =>
            props.onChange({
              ...entry,
              effort: e.target.value === "" ? null : e.target.value,
            })
          }
          placeholder="effort"
          className={cn(INPUT_CLASS, "w-28")}
        />
      )}
      <input
        value={entry.family}
        onChange={(e) => props.onChange({ ...entry, family: e.target.value })}
        placeholder="family"
        className={cn(INPUT_CLASS, "w-24")}
      />
      <input
        value={entry.note}
        onChange={(e) => props.onChange({ ...entry, note: e.target.value })}
        placeholder="note (optional)"
        className={cn(INPUT_CLASS, "flex-1")}
      />
    </div>
  );
}

// ─── Add model row ──────────────────────────────────────────────────────────

function AddModelRow(props: {
  readonly catalog: GuiHarnessCatalog;
  readonly existingKeys: readonly string[];
  readonly onAdd: (entry: TraycerModelEntry) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ModelDraft | null>(null);

  const selectedHarness =
    props.catalog.harnesses.find((h) => h.id === draft?.harnessId) ?? null;
  const availableModels = (selectedHarness?.models ?? []).filter(
    (m) => !props.existingKeys.includes(`${m.harnessId}/${m.slug}`),
  );
  const selectedModel =
    availableModels.find((m) => m.slug === draft?.slug) ?? null;

  const handleAdd = () => {
    if (draft === null || selectedModel === null) return;
    props.onAdd({
      harnessId: draft.harnessId,
      model: draft.slug,
      effort: draft.effort ?? selectedModel.defaultReasoningEffort,
      family: deriveFamily(draft.harnessId, draft.slug),
      note: "",
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border/50 px-2 py-1.5">
      <DraftProviderSelect
        catalog={props.catalog}
        draft={draft}
        onChange={setDraft}
      />
      <DraftModelSelect
        models={availableModels}
        loading={props.catalog.modelsLoading}
        draft={draft}
        onChange={setDraft}
      />
      <DraftEffortSelect
        model={selectedModel}
        draft={draft}
        onChange={setDraft}
      />
      <Button
        size="sm"
        className="text-ui-xs"
        disabled={selectedModel === null}
        onClick={handleAdd}
      >
        Add
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-ui-xs"
        onClick={props.onCancel}
      >
        Cancel
      </Button>
    </div>
  );
}

function DraftProviderSelect(props: {
  readonly catalog: GuiHarnessCatalog;
  readonly draft: ModelDraft | null;
  readonly onChange: (draft: ModelDraft | null) => void;
}) {
  return (
    <select
      value={props.draft?.harnessId ?? ""}
      onChange={(e) =>
        props.onChange(
          e.target.value === ""
            ? null
            : { harnessId: e.target.value, slug: "", effort: null },
        )
      }
      className={cn(INPUT_CLASS, "w-32")}
      aria-label="Provider"
    >
      <option value="">Provider…</option>
      {props.catalog.harnesses.map((h) => (
        <option key={h.id} value={h.id}>
          {h.label}
        </option>
      ))}
    </select>
  );
}

function DraftModelSelect(props: {
  readonly models: readonly {
    readonly harnessId: string;
    readonly slug: string;
    readonly label: string;
  }[];
  readonly loading: boolean;
  readonly draft: ModelDraft | null;
  readonly onChange: (draft: ModelDraft) => void;
}) {
  return (
    <select
      value={props.draft?.slug ?? ""}
      onChange={(e) =>
        props.draft !== null &&
        props.onChange({ ...props.draft, slug: e.target.value })
      }
      disabled={props.draft === null}
      className={cn(INPUT_CLASS, "w-56")}
      aria-label="Model"
    >
      <option value="">{props.loading ? "Loading models…" : "Model…"}</option>
      {props.models.map((m) => (
        <option key={m.slug} value={m.slug}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

function DraftEffortSelect(props: {
  readonly model: {
    readonly defaultReasoningEffort: string | null;
    readonly supportedReasoningEfforts: readonly {
      readonly id: string;
      readonly label: string;
    }[];
  } | null;
  readonly draft: ModelDraft | null;
  readonly onChange: (draft: ModelDraft) => void;
}) {
  const defaultLabel =
    props.model?.defaultReasoningEffort !== null &&
    props.model?.defaultReasoningEffort !== undefined
      ? `default (${props.model.defaultReasoningEffort})`
      : "Effort…";
  return (
    <select
      value={props.draft?.effort ?? ""}
      onChange={(e) =>
        props.draft !== null &&
        props.onChange({
          ...props.draft,
          effort: e.target.value === "" ? null : e.target.value,
        })
      }
      disabled={props.model === null}
      className={cn(INPUT_CLASS, "w-32")}
      aria-label="Effort"
    >
      <option value="">{defaultLabel}</option>
      {(props.model?.supportedReasoningEfforts ?? []).map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
