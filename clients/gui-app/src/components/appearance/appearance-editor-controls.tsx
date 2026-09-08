import { useId, useState } from "react";
import {
  APPEARANCE_SYMBOLS,
  type WorkspaceAppearance,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REPOSITORY_SYMBOL_ICONS } from "@/components/layout/tabs/repository-identity-presentation";
import type { AppearanceWallpaperImage } from "@/components/home/appearance-wallpaper";

export function AppearanceChoice(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ui-sm">{props.label}</span>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger aria-label={props.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AppearanceRange(props: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_3ch] items-center gap-3 text-ui-xs">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(props.value * 100)}
        onChange={(event) =>
          props.onChange(event.currentTarget.valueAsNumber / 100)
        }
        className="w-full accent-primary"
      />
      <output htmlFor={id} className="text-right tabular-nums">
        {Math.round(props.value * 100)}
      </output>
    </div>
  );
}

export function WallpaperImageControls(props: {
  readonly image: AppearanceWallpaperImage;
  readonly onChange: (image: AppearanceWallpaperImage) => void;
}) {
  const { image, onChange } = props;
  return (
    <div className="space-y-3">
      <AppearanceChoice
        label="Treatment"
        value={image.treatment}
        options={[
          { value: "original", label: "Original" },
          { value: "texture", label: "Texture" },
          { value: "dither", label: "Dither" },
        ]}
        onChange={(treatment) => {
          if (
            treatment === "original" ||
            treatment === "texture" ||
            treatment === "dither"
          )
            onChange({ ...image, treatment });
        }}
      />
      <AppearanceRange
        label="Horizontal focus"
        value={image.focalPoint[0]}
        onChange={(value) =>
          onChange({ ...image, focalPoint: [value, image.focalPoint[1]] })
        }
      />
      <AppearanceRange
        label="Vertical focus"
        value={image.focalPoint[1]}
        onChange={(value) =>
          onChange({ ...image, focalPoint: [image.focalPoint[0], value] })
        }
      />
      <AppearanceRange
        label="Dimming"
        value={image.dimming}
        onChange={(dimming) => onChange({ ...image, dimming })}
      />
      {image.treatment !== "original" ? (
        <AppearanceRange
          label="Effect strength"
          value={image.strength}
          onChange={(strength) => onChange({ ...image, strength })}
        />
      ) : null}
    </div>
  );
}

export function RepositoryIconChoices(props: {
  readonly icon: WorkspaceAppearance["icon"];
  readonly onChange: (icon: WorkspaceAppearance["icon"]) => void;
}) {
  const [search, setSearch] = useState("");
  if (props.icon?.kind === "emoji")
    return (
      <div className="space-y-2">
        <Input
          aria-label="Emoji"
          value={props.icon.value}
          maxLength={32}
          onChange={(event) =>
            props.onChange({ kind: "emoji", value: event.currentTarget.value })
          }
        />
        <div className="flex flex-wrap gap-1">
          {["🚀", "🌱", "🧪", "🎨", "📚", "🛠️"].map((emoji) => (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Use ${emoji}`}
              onClick={() => props.onChange({ kind: "emoji", value: emoji })}
            >
              {emoji}
            </Button>
          ))}
        </div>
      </div>
    );
  if (props.icon?.kind !== "symbol") return null;
  return (
    <div className="space-y-2">
      <Input
        type="search"
        aria-label="Search symbols"
        placeholder="Search symbols"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      <div className="flex flex-wrap gap-1">
        {APPEARANCE_SYMBOLS.filter((value) =>
          value.includes(search.toLowerCase().trim()),
        ).map((value) => {
          const Icon = REPOSITORY_SYMBOL_ICONS[value];
          return (
            <Button
              key={value}
              type="button"
              variant={
                props.icon?.kind === "symbol" && props.icon.value === value
                  ? "secondary"
                  : "ghost"
              }
              size="icon-sm"
              aria-label={value}
              aria-pressed={
                props.icon?.kind === "symbol" && props.icon.value === value
              }
              onClick={() => props.onChange({ kind: "symbol", value })}
            >
              <Icon className="size-4" />
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function ImageFile(props: {
  readonly label: string;
  readonly onSelect: (file: File) => void;
}) {
  return (
    <label className="block space-y-1 text-ui-xs">
      <span>{props.label}</span>
      <Input
        type="file"
        aria-label={props.label}
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) props.onSelect(file);
        }}
      />
      <span className="text-muted-foreground">
        PNG, JPEG, or WebP, up to 20 MiB.
      </span>
    </label>
  );
}
