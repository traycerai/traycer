import { ChevronDown } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ASSIGNABLE_COLLABORATOR_ROLES,
  ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA,
  EPIC_COLLABORATOR_ROLE_LABELS,
  type AssignableCollaboratorRole,
  type PermissionRole,
} from "@/lib/epic-collaborator-roles";
import { cn } from "@/lib/utils";

export const ROLE_PILL_CLASS =
  "rounded-md bg-muted px-2.5 py-1 text-ui-xs text-muted-foreground";

export interface RoleDropdownProps {
  readonly value: PermissionRole;
  readonly onChange: (newRole: AssignableCollaboratorRole) => void;
  readonly disabled: boolean;
  readonly isPending: boolean;
  readonly className: string;
  readonly "aria-label": string;
  readonly "data-testid": string;
}

export function RoleDropdown(props: RoleDropdownProps) {
  const {
    value,
    onChange,
    disabled,
    isPending,
    className,
    "aria-label": ariaLabel,
    "data-testid": testId,
  } = props;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "justify-between gap-1.5 border-transparent text-ui-sm",
            className,
          )}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          <span className="truncate">
            {EPIC_COLLABORATOR_ROLE_LABELS[value]}
          </span>
          {isPending ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId={`${testId}-spinner`}
              variant={undefined}
            />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const role = ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA.safeParse(next);
            if (role.success) {
              onChange(role.data);
            }
          }}
        >
          {ASSIGNABLE_COLLABORATOR_ROLES.map((role) => (
            <DropdownMenuRadioItem key={role} value={role}>
              {EPIC_COLLABORATOR_ROLE_LABELS[role]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RoleOrBadge(props: {
  value: PermissionRole;
  canChange: boolean;
  disabled: boolean;
  isPending: boolean;
  ariaLabel: string;
  testId: string;
  onChange: (role: AssignableCollaboratorRole) => void;
}) {
  if (!props.canChange) {
    return (
      <RoleBadge
        value={props.value}
        testId={`${props.testId}-badge`}
        ariaLabel={undefined}
        title={undefined}
      />
    );
  }
  return (
    <RoleDropdown
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
      isPending={props.isPending}
      className="min-w-24 justify-between rounded-md bg-muted px-2.5 py-1 text-ui-sm text-muted-foreground"
      aria-label={props.ariaLabel}
      data-testid={props.testId}
    />
  );
}

export function RoleBadge(props: {
  readonly value: PermissionRole;
  readonly testId: string;
  readonly ariaLabel: string | undefined;
  readonly title: string | undefined;
}) {
  return (
    <span
      className={ROLE_PILL_CLASS}
      title={props.title}
      aria-label={props.ariaLabel}
      data-testid={props.testId}
    >
      {EPIC_COLLABORATOR_ROLE_LABELS[props.value]}
    </span>
  );
}
