import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Props = { tone: "warn" | "danger" | "info"; icon: IconName; title?: ReactNode; children?: ReactNode; actions?: ReactNode; role?: "alert" | "status"; "data-ui"?: string };

export function Banner({ tone, icon, title, children, actions, role, ...ui }: Props) {
  return (
    <div className={`banner tint tone-${tone === "info" ? "primary" : tone}`} role={role ?? (tone === "info" ? undefined : "alert")} data-ui={ui["data-ui"]}>
      <span className="banner-icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="banner-body">
        {title && <div className="banner-title">{title}</div>}
        {children && <div className="banner-text">{children}</div>}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}
