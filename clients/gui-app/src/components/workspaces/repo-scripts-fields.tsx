import { useId, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  OsForm,
  RepoScriptsValue,
} from "@/components/workspaces/repo-scripts-form";

/**
 * Controlled per-OS setup/teardown field group. Hosts own persistence - this
 * carries no save button or mutation. Pure helpers/types live in
 * `repo-scripts-form.ts`.
 *
 * Each script is authored across per-OS tabs (Default / macOS / Linux /
 * Windows); the host runs the platform-specific command and falls back to
 * Default when the active platform's field is blank (`resolveOsCommand`).
 */
export function RepoScriptsFields(props: {
  readonly value: RepoScriptsValue;
  readonly onChange: (next: RepoScriptsValue) => void;
}) {
  const { value, onChange } = props;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ScriptField
        label="Setup script"
        type="setup"
        description="At the project root when a worktree is created."
        form={value.setup}
        onChange={(setup) => onChange({ ...value, setup })}
      />
      <ScriptField
        label="Teardown script"
        type="teardown"
        description="At the project root before a worktree is removed."
        form={value.teardown}
        onChange={(teardown) => onChange({ ...value, teardown })}
      />
      <p className="text-ui-xs text-muted-foreground md:col-span-2">
        Platform scripts override Default. Leave blank to use Default.
      </p>
    </div>
  );
}

interface OsTab {
  readonly key: keyof OsForm;
  readonly label: string;
}

const SETUP_PLACEHOLDER = `bun install\nmake build`;
const TEARDOWN_PLACEHOLDER = `bun run cleanup`;

const OS_TABS: readonly OsTab[] = [
  { key: "default", label: "Default" },
  { key: "macos", label: "macOS" },
  { key: "linux", label: "Linux" },
  { key: "windows", label: "Windows" },
];

function ScriptField(props: {
  readonly label: string;
  readonly type: "setup" | "teardown";
  readonly description: string;
  readonly form: OsForm;
  readonly onChange: (next: OsForm) => void;
}) {
  const { label, type, description, form, onChange } = props;
  const descriptionId = useId();
  // Tab selection is view-only state; the value lives in `form`. A plain
  // string avoids narrowing `onValueChange` - the typed `keyof OsForm` binding
  // comes from the `OS_TABS` entry inside each panel.
  const [activeOs, setActiveOs] = useState<string>("default");
  return (
    <div className="min-w-0 space-y-2.5">
      <div className="space-y-0.5">
        <div className="text-ui-sm font-medium text-foreground">{label}</div>
        <p id={descriptionId} className="text-ui-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Tabs
        value={activeOs}
        onValueChange={setActiveOs}
        className="gap-0 overflow-hidden rounded-lg border border-foreground/15 bg-foreground/3 focus-within:border-ring"
      >
        <TabsList
          aria-label={`${label} platform`}
          className="w-full justify-start rounded-none border-b border-foreground/10 bg-foreground/5 p-1 group-data-[orientation=horizontal]/tabs:h-auto"
        >
          {OS_TABS.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              className="min-h-8 px-2 text-ui-xs"
            >
              <span>{tab.label}</span>
              {tab.key !== "default" && form[tab.key].trim().length > 0 ? (
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {OS_TABS.map((tab) => (
          <TabsContent key={tab.key} value={tab.key}>
            <Textarea
              value={form[tab.key]}
              rows={3}
              spellCheck={false}
              placeholder={
                type === "setup" ? SETUP_PLACEHOLDER : TEARDOWN_PLACEHOLDER
              }
              aria-label={`${label} (${tab.label})`}
              aria-describedby={descriptionId}
              className="field-sizing-fixed resize-y rounded-none border-0 bg-transparent px-3 py-3 font-mono text-code-xs leading-relaxed placeholder:text-muted-foreground/50 focus-visible:ring-inset dark:bg-transparent"
              onChange={(event) =>
                onChange({ ...form, [tab.key]: event.target.value })
              }
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
