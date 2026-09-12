import { useId, type ComponentProps, type ReactNode } from "react";
import type { TierCandidate } from "@traycer/protocol/host/fallback-policy";
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/agent/shared";
import { Input } from "@/components/ui/input";
import { useGuiHarnessModelsQuery } from "@/hooks/harnesses/use-gui-harness-catalog";

type FamilyInputProps = ComponentProps<typeof Input> & {
  readonly harnessId: TierCandidate["harnessId"];
};

/**
 * Catalog slugs are exact family expressions in the host resolver.
 *
 * This used to append "Choose a catalog model or type a family name." beside
 * the field. It was `w-full` inside the row's wrapping flex, so it did not sit
 * beside anything - it forced a line break and split every model onto four
 * lines, then said the same sentence again for the next model. The editor
 * states it once, above the table.
 */
export function FallbackModelFamilyInput(props: FamilyInputProps): ReactNode {
  const { harnessId, ...inputProps } = props;
  const parsed = guiHarnessIdSchema.safeParse(harnessId);
  if (!parsed.success) return <Input {...inputProps} />;
  return <CatalogFamilyInput harnessId={parsed.data} inputProps={inputProps} />;
}

function CatalogFamilyInput(props: {
  readonly harnessId: GuiHarnessId;
  readonly inputProps: ComponentProps<typeof Input>;
}): ReactNode {
  const { harnessId, inputProps } = props;
  const instanceId = useId();
  const listId = `${inputProps.id ?? instanceId}-catalog-families`;
  // The panel's effort-options hook owns fetching these shared catalog slots.
  // This observer only reads them, including updates, and never starts a second
  // fetch. An absent or failed slot leaves unrestricted free text in place.
  const catalog = useGuiHarnessModelsQuery(harnessId, null, {
    enabled: false,
    subscribed: true,
  });
  const models = catalog.data?.models ?? [];
  const uniqueModels = [
    ...new Map(models.map((model) => [model.slug, model])).values(),
  ];
  return (
    <>
      <Input
        {...inputProps}
        list={uniqueModels.length === 0 ? undefined : listId}
      />
      {uniqueModels.length === 0 ? null : (
        <datalist id={listId}>
          {uniqueModels.map((model) => (
            <option key={model.slug} value={model.slug}>
              {model.label}
            </option>
          ))}
        </datalist>
      )}
    </>
  );
}
