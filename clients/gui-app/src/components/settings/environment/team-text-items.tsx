import { useState, type ReactNode } from "react";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import { configurationTextValueSchema } from "@/hooks/environment/team/configuration-item-values";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "./configuration-source";

const OS_LABELS: Readonly<Record<Exclude<EnvironmentOs, "any">, string>> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

/**
 * Row addresses and revisions come from the pool, never from a live host.
 *
 * `os` is the scope a new item is written under. Under `any` every item of
 * every scope is listed, each one scoped to a single OS labelled with it;
 * under a single OS only that OS's items are.
 */
export function TeamTextItems(props: {
  readonly items: readonly ConfigurationItem[];
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  readonly providerId: string | null;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
  readonly renderDetails: (item: ConfigurationItem) => ReactNode;
}): ReactNode {
  const canEdit = useCanEditConfiguration();
  const rows = props.items.filter(
    (item) =>
      item.kind === props.kind &&
      (props.os === "any" || item.os === props.os) &&
      (props.providerId === null ||
        item.key.startsWith(`${props.providerId}:`)),
  );
  return (
    <div className="flex flex-col gap-3">
      {rows.map((item) => (
        <TeamTextItemEditor
          // A row is kind+key+os, and its key carries any provider prefix;
          // the draft seeds from it once, so a new address must remount.
          key={`${item.os}:${item.key}:${item.revision}`}
          item={item}
          kind={props.kind}
          os={props.os}
          osLabel={
            props.os === "any" && item.os !== null && item.os !== "any"
              ? OS_LABELS[item.os]
              : null
          }
          providerId={props.providerId}
          onOutcome={props.onOutcome}
          details={props.renderDetails(item)}
        />
      ))}
      {rows.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">No variables yet.</p>
      ) : null}
      {canEdit ? (
        <TeamTextItemEditor
          key={`new:${props.kind}:${props.os}:${props.providerId}`}
          item={null}
          kind={props.kind}
          os={props.os}
          osLabel={null}
          providerId={props.providerId}
          onOutcome={props.onOutcome}
          details={null}
        />
      ) : null}
    </div>
  );
}

function TeamTextItemEditor(props: {
  readonly item: ConfigurationItem | null;
  readonly kind: "variable" | "env_override";
  readonly os: EnvironmentOs;
  /** The single OS a row listed under `any` is scoped to, else `null`. */
  readonly osLabel: string | null;
  readonly providerId: string | null;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
  readonly details: ReactNode;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put, remove } = useConfigurationItemMutations();
  const saved =
    props.item === null
      ? ""
      : configurationTextValueSchema.parse(props.item.value).value;
  const [name, setName] = useState("");
  const [value, setValue] = useState(saved);
  const title = props.item?.key ?? "New variable";
  const label = props.osLabel === null ? title : `${title} · ${props.osLabel}`;
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim());
  const save = (): void => {
    if (source.kind !== "pool") return;
    const key =
      props.item?.key ??
      (props.providerId === null
        ? name.trim()
        : `${props.providerId}:${name.trim()}`);
    put.mutate(
      {
        environmentId: source.environmentId,
        kind: props.kind,
        key,
        // An item keeps its own scope; only a new one takes the picker's.
        os: props.item?.os ?? props.os,
        value: { value },
        revision: props.item?.revision ?? null,
      },
      {
        onSuccess: (result) => {
          props.onOutcome(result);
          if (result.outcome === "saved" && props.item === null) {
            setName("");
            setValue("");
          }
        },
      },
    );
  };
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      aria-label={label}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-ui-sm">{title}</span>
          {props.osLabel === null ? null : (
            <Badge variant="secondary" size="xs">
              {props.osLabel}
            </Badge>
          )}
        </span>
        {props.details}
      </div>
      {props.item === null ? (
        <Input
          aria-label="Variable name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="NODE_ENV"
        />
      ) : null}
      {canEdit ? (
        <Input
          aria-label={`${label} value`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <span className="font-mono text-ui-sm">{saved}</span>
      )}
      {canEdit ? (
        <div className="flex justify-end gap-2">
          {props.item === null ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={remove.isPending || put.isPending}
              onClick={() => {
                if (source.kind === "pool" && props.item !== null)
                  remove.mutate(
                    {
                      environmentId: source.environmentId,
                      kind: props.kind,
                      key: props.item.key,
                      os: props.item.os,
                      revision: props.item.revision,
                    },
                    { onSuccess: props.onOutcome },
                  );
              }}
            >
              Delete
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={
              put.isPending ||
              remove.isPending ||
              (props.item === null ? !validName : value === saved)
            }
            onClick={save}
          >
            {props.item === null ? "Add a variable" : "Save"}
            {put.isPending ? <MutedAgentSpinner /> : null}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
