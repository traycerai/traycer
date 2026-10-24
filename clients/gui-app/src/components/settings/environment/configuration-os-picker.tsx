import type { ReactNode } from "react";
import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ConfigurationOsPicker(props: {
  readonly value: EnvironmentOs;
  readonly onChange: (value: EnvironmentOs) => void;
}): ReactNode {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (
          value === "any" ||
          value === "linux" ||
          value === "macos" ||
          value === "windows"
        )
          props.onChange(value);
      }}
    >
      <SelectTrigger aria-label="Operating system" className="max-w-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="any">All operating systems</SelectItem>
        <SelectItem value="linux">Linux</SelectItem>
        <SelectItem value="macos">macOS</SelectItem>
        <SelectItem value="windows">Windows</SelectItem>
      </SelectContent>
    </Select>
  );
}
