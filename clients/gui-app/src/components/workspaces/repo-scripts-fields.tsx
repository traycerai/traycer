import { useState } from "react";
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
    <div className="flex flex-col gap-4">
      <ScriptField
        label="Setup script"
        type="setup"
        description="Runs at the project root on worktree creation."
        form={value.setup}
        onChange={(setup) => onChange({ ...value, setup })}
      />
      <ScriptField
        label="Teardown script"
        type="teardown"
        description="Runs at the project root before worktree cleanup."
        form={value.teardown}
        onChange={(teardown) => onChange({ ...value, teardown })}
      />
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
  // Tab selection is view-only state; the value lives in `form`. A plain
  // string avoids narrowing `onValueChange` - the typed `keyof OsForm` binding
  // comes from the `OS_TABS` entry inside each panel.
  const [activeOs, setActiveOs] = useState<string>("default");
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <div className="text-ui-sm font-medium text-foreground">{label}</div>
        <p className="text-ui-xs text-muted-foreground">{description}</p>
      </div>
      <Tabs value={activeOs} onValueChange={setActiveOs} className="gap-1">
        <TabsList>
          {OS_TABS.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              className="flex-none px-3 text-ui-xs"
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
              rows={4}
              spellCheck={false}
              placeholder={
                type === "setup" ? SETUP_PLACEHOLDER : TEARDOWN_PLACEHOLDER
              }
              aria-label={`${label} (${tab.label})`}
              className="font-mono text-code-xs"
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
