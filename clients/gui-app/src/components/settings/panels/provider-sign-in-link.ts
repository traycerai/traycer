import { reportableErrorToast } from "@/lib/reportable-error-toast";

export function handleSignInLinkCopyError(): void {
  reportableErrorToast("Couldn't copy the sign-in link.", undefined, {
    title: "Could not copy sign-in link",
    message: null,
    code: null,
    source: "Provider sign-in",
  });
}
