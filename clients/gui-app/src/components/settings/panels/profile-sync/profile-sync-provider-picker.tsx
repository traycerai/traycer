import { cn } from "@/lib/utils";
import { useState, type ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command";
import {
  profileCopyWireProvider,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import { profileCopyProviderLabel } from "../profile-copy/profile-copy-shared";

export function ProfileSyncProviderPicker(props: {
  readonly providers: readonly ProviderCliState[];
  readonly selected: readonly ProfileCopyWireProvider[];
  readonly onChange: (selected: ProfileCopyWireProvider[]) => void;
  readonly disabled: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const eligible = props.providers.flatMap((p) => {
    const id = profileCopyWireProvider(p.providerId);
    return id === null ? [] : [{ id, count: p.profiles.length }];
  });
  const count = eligible
    .filter((p) => props.selected.includes(p.id))
    .reduce((n, p) => n + p.count, 0);
  const allEligibleSelected = eligible.every((p) =>
    props.selected.includes(p.id),
  );
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-sm font-medium">Providers</h3>
        <span className="text-ui-xs text-muted-foreground">
          {props.selected.length} selected · {count} profiles
        </span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between"
            aria-label="Choose providers"
            disabled={props.disabled}
          >
            <span className="min-w-0 truncate">
              {props.selected.length
                ? props.selected.map(profileCopyProviderLabel).join(", ")
                : "Choose providers"}
            </span>
            <ChevronsUpDown data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          layout="bare"
          align="start"
          className="w-[var(--radix-popover-trigger-width)]"
        >
          <Command variant="embedded" selection="flat">
            <CommandInput
              placeholder="Find a provider…"
              disabled={props.disabled}
            />
            <div className="flex justify-end px-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={props.disabled}
                onClick={() =>
                  props.onChange(
                    allEligibleSelected
                      ? []
                      : [
                          ...new Set([
                            ...props.selected,
                            ...eligible.map((p) => p.id),
                          ]),
                        ],
                  )
                }
              >
                {allEligibleSelected ? "Clear" : "Select all"}
              </Button>
            </div>
            <CommandList>
              <CommandEmpty>No providers found.</CommandEmpty>
              {eligible.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  disabled={props.disabled}
                  onSelect={() =>
                    props.onChange(
                      props.selected.includes(p.id)
                        ? props.selected.filter((id) => id !== p.id)
                        : [...props.selected, p.id],
                    )
                  }
                >
                  <Check
                    className={cn(
                      "size-3.5",
                      !props.selected.includes(p.id) && "opacity-0",
                    )}
                  />
                  <span className="flex-1">
                    {profileCopyProviderLabel(p.id)}
                  </span>
                  <span className="text-ui-xs text-muted-foreground">
                    {p.count} profiles
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-ui-xs text-muted-foreground">
        Includes all profiles for the selected providers. Names, colors and
        agent availability sync; installations and native settings stay on each
        device.
      </p>
      {props.providers.some(
        (p) =>
          p.profiles.length > 0 &&
          profileCopyWireProvider(p.providerId) === null,
      ) ? (
        <p className="text-ui-xs text-muted-foreground">
          Some providers do not support profile transfer yet and are not
          selectable.
        </p>
      ) : null}
    </section>
  );
}
