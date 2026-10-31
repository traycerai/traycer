import type { ReactNode } from "react";

/** One of a bot's settings groups, under its heading. */
export function SettingsGroup(props: {
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      aria-label={props.title}
      data-testid={props.testId}
      className="flex flex-col gap-4"
    >
      <h3 className="text-ui-sm font-semibold text-foreground">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

/** A write's refusal, under the control that made it. */
export function BotSettingsRefusal(props: {
  readonly message: string | null;
}): ReactNode {
  if (props.message === null) return null;
  return (
    <p
      role="alert"
      className="text-ui-xs text-destructive"
      data-testid="bot-settings-refusal"
    >
      {props.message}
    </p>
  );
}
