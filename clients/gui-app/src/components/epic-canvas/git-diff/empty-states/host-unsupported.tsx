import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HostUnsupported(props: { readonly reason: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-stretch bg-background p-4">
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-destructive"
      >
        <div className="flex gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0" />
          <div className="flex-1">
            <h2 className="font-semibold">Git panel unavailable</h2>
            <p className="mt-2 text-sm">{props.reason}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" className="w-fit" asChild>
          <a href="#update-host">Update Traycer Host</a>
        </Button>
      </div>
    </div>
  );
}
