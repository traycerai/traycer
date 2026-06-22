import type { ReactNode } from "react";

interface AdvancedSectionProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function AdvancedSection(props: AdvancedSectionProps) {
  const { title, description, children } = props;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <div className="font-medium text-foreground">{title}</div>
        <p className="text-ui-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
