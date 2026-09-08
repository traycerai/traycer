import { Folder } from "lucide-react";
import { useAppearanceAsset } from "@/hooks/appearance/use-appearance-assets";
import type { HeaderTabRepositoryIdentity, TabIcon } from "@/stores/tabs/types";

export function RepositoryIdentityIcon(props: {
  readonly identity: HeaderTabRepositoryIdentity;
  readonly fallbackIcon: TabIcon | null;
}) {
  const icon = props.identity.icon;
  if (icon === null) return null;
  if (icon.kind === "image") {
    return <RepositoryLogo {...props} path={icon.path} />;
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-3.5 shrink-0 items-center justify-center text-sm leading-none"
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
    return <Icon className="size-3.5 shrink-0" />;
  }
  return (
    <img
      src={asset.url}
      alt=""
      className="size-3.5 shrink-0 object-contain"
      onError={asset.reportDecodeFailure}
    />
  );
}
