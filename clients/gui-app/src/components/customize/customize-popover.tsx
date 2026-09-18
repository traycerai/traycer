import { isCustomizePointerInput } from "@/lib/customize/enter-exit";
import { useCustomizeLayout } from "@/components/customize/use-customize-layout";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTitle,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { getCustomizeSetting } from "@/lib/customize/catalog";
import {
  getCustomizeOptions,
  useCustomizeOptionsRegistry,
  type CustomizeControl,
  type CustomizeOptionSpec,
} from "@/lib/customize/customize-options";
import {
  findCustomizeProxy,
  focusCustomizeInvoker,
} from "@/lib/customize/focus";
import { recordSettingGesture } from "@/lib/customize/history";
import { LayoutOverrideProvider } from "@/providers/layout-override-provider";
import { useCustomizeStore } from "@/stores/customize/customize-store";

export function CustomizePopover({
  rects,
}: {
  rects: ReadonlyMap<string, DOMRect>;
}) {
  const session = useCustomizeStore((state) => state.session);
  const key = useCustomizeStore((state) => state.popoverKey);
  const instance = useCustomizeStore((state) =>
    key ? state.instances.get(key) : undefined,
  );
  const disclosure = useCustomizeStore((state) => state.disclosure);
  useCustomizeOptionsRegistry();
  // The open form displays controls spanning all three stores. No subscriptions
  // are added to each idle hotspot; only this single open form observes them.
  useCustomizeLayout();
  const rect = key ? rects.get(key) : undefined;
  const virtualRef = useMemo(
    () => ({ current: { getBoundingClientRect: () => rect ?? new DOMRect() } }),
    [rect],
  );
  if (!instance || !rect) return null;
  const options = getCustomizeOptions(instance);
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) useCustomizeStore.getState().closePopover();
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        data-customize-keyboard={!isCustomizePointerInput() || undefined}
        data-customize-editor
        className="pointer-events-auto max-h-[70svh] overflow-y-auto"
        onInteractOutside={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("[data-customize-editor]")
          )
            event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Removal recovery belongs to the overlay; delayed Radix teardown
          // must not override its nearest-proxy destination.
          if (
            useCustomizeStore.getState().session === session &&
            findCustomizeProxy(instance.key)
          )
            focusCustomizeInvoker();
        }}
      >
        <PopoverTitle>
          {getCustomizeSetting(instance.settingId).label}
        </PopoverTitle>
        {instance.condition ? (
          <p className="text-ui-sm text-muted-foreground">
            {instance.condition}
          </p>
        ) : null}
        {options?.control ? (
          <Control
            key={`${instance.key}:${disclosure ?? ""}`}
            control={options.control}
            disclosure={disclosure}
          />
        ) : (
          <p className="text-ui-sm text-muted-foreground">
            Options will appear when this surface is connected.
          </p>
        )}
        {options?.moves.length ? (
          <div role="group" aria-label="Move" className="flex flex-wrap gap-1">
            {options.moves.map((move) => (
              <Button
                key={move.id}
                size="sm"
                variant="outline"
                disabled={move.disabled}
                onClick={() => {
                  recordSettingGesture(
                    move.analytics,
                    move.label,
                    move.touches,
                    move.run,
                  );
                  useCustomizeStore.getState().announce(move.announcement);
                  useCustomizeStore.getState().closePopover();
                  requestAnimationFrame(() =>
                    findCustomizeProxy(instance.key)?.focus({
                      preventScroll: true,
                    }),
                  );
                }}
              >
                {move.label}
              </Button>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
function Picture({ option }: { option: CustomizeOptionSpec }) {
  return option.picture ? (
    <div inert aria-hidden className="pointer-events-none">
      <LayoutOverrideProvider value={option.override}>
        {option.picture()}
      </LayoutOverrideProvider>
    </div>
  ) : null;
}
function Control({
  control,
  disclosure,
}: {
  control: CustomizeControl;
  disclosure: string | null;
}) {
  const [expanded, setExpanded] = useState(
    control.kind === "composite" &&
      disclosure !== null &&
      control.more.some((item) =>
        `${item.id} ${item.label}`
          .toLowerCase()
          .includes(disclosure.toLowerCase()),
      ),
  );
  const mutate = (run: () => void) =>
    recordSettingGesture(
      control.analytics,
      control.label,
      control.touches,
      run,
    );
  if (control.kind === "composite")
    return (
      <>
        <Control control={control.primary} disclosure={null} />
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              More
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3">
              {control.more.map((item) => (
                <Control key={item.id} control={item} disclosure={null} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </>
    );
  if (control.kind === "choice")
    return (
      <RadioGroup
        aria-label={control.label}
        value={control.value}
        onValueChange={(value) => {
          if (
            control.options.some(
              (option) => option.value === value && !option.disabled,
            )
          )
            mutate(() => control.change(value));
        }}
      >
        {control.options.map((option) => (
          <label
            key={option.value}
            className="flex flex-wrap items-center gap-2 text-ui-sm"
          >
            <RadioGroupItem value={option.value} disabled={option.disabled} />
            {option.label}
            <Picture option={option} />
          </label>
        ))}
      </RadioGroup>
    );
  if (control.kind === "toggle")
    return (
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-ui-sm">
          <Switch
            checked={control.checked}
            onCheckedChange={(checked) => mutate(() => control.change(checked))}
          />
          {control.label}
        </label>
        {control.pictures.map((option) => (
          <Picture key={option.value} option={option} />
        ))}
      </div>
    );
  const moveItem = control.moveItem;
  return (
    <div
      role="group"
      aria-label={control.label}
      className="flex flex-col gap-2"
    >
      {control.options.map((option, index) => {
        const checked = control.values.includes(option.value);
        return (
          <div key={option.value} className="flex flex-wrap items-center gap-2">
            <label className="flex flex-1 flex-wrap items-center gap-2 text-ui-sm">
              <Checkbox
                checked={checked}
                disabled={
                  option.disabled ||
                  (checked &&
                    control.lastItemHeld &&
                    control.values.length === 1)
                }
                onCheckedChange={(next) =>
                  mutate(() =>
                    control.change(
                      next === true
                        ? [...control.values, option.value]
                        : control.values.filter(
                            (value) => value !== option.value,
                          ),
                    ),
                  )
                }
              />
              {option.label}
              <Picture option={option} />
            </label>
            {moveItem ? (
              <div
                role="group"
                aria-label={`Move ${option.label}`}
                className="flex gap-1"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={index === 0}
                  onClick={() => mutate(() => moveItem(option.value, -1))}
                >
                  Move up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={index === control.options.length - 1}
                  onClick={() => mutate(() => moveItem(option.value, 1))}
                >
                  Move down
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
