import { Folder } from "lucide-react";
import { useAppearanceAsset } from "@/hooks/appearance/use-appearance-assets";
import type { HeaderTabRepositoryIdentity, TabIcon } from "@/stores/tabs/types";

/**
 * Caller MUST gate on `identity.icon !== null` before rendering this - see
 * `TabLeadingIcon`, the only caller, which also uses that check to decide
 * whether to render the wrapping icon slot at all. A second null check here
 * would be unreachable.
 */
export function RepositoryIdentityIcon(props: {
  readonly identity: HeaderTabRepositoryIdentity & {
    readonly icon: NonNullable<HeaderTabRepositoryIdentity["icon"]>;
  };
  readonly fallbackIcon: TabIcon | null;
}) {
  const icon = props.identity.icon;
  if (icon.kind === "image") {
    return <RepositoryLogo {...props} path={icon.path} />;
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-5 shrink-0 items-center justify-center text-lg leading-none"
    >
      {icon.value}
    </span>
  );
}

function RepositoryLogo(props: {
  readonly identity: HeaderTabRepositoryIdentity;
  readonly fallbackIcon: TabIcon | null;
  readonly path: string;
}) {
  const asset = useAppearanceAsset({
    scope: props.identity.scope,
    path: props.path,
    rejected: props.identity.iconRejected,
    focused: true,
    refreshKey: props.identity.assetRefreshKey,
  });
  if (asset.url === null) {
    const Icon = props.fallbackIcon ?? Folder;
    return <Icon className="size-5 shrink-0" />;
  }
  return (
    <img
      src={asset.url}
      alt=""
      className="size-5 shrink-0 object-contain"
      onError={asset.reportDecodeFailure}
    />
  );
}
