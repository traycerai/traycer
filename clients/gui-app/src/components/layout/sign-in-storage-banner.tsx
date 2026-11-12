import type { ReactNode } from "react";
import { HardDrive } from "lucide-react";
import { useAuthStore } from "@/stores/auth/auth-store";
import { cn } from "@/lib/utils";
import {
  DISK_FULL_SIGN_IN_TITLE,
  DISK_FULL_SIGN_IN_BODY,
} from "@traycer-clients/shared/auth/sign-in-storage";

export function SignInStorageBanner(): ReactNode {
  const low = useAuthStore((state) => state.signInStorageLow);
  if (!low) return null;
  return (
    <output
      aria-label={DISK_FULL_SIGN_IN_TITLE}
      className={cn(
        "flex w-full items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-ui-xs text-warning-foreground",
      )}
    >
      <HardDrive className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <strong>{DISK_FULL_SIGN_IN_TITLE}</strong> {DISK_FULL_SIGN_IN_BODY}
      </span>
    </output>
  );
}
