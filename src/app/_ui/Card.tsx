import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Props = {
  title?: ReactNode;
  icon?: IconName;
  hint?: ReactNode;
  actions?: ReactNode;
  variant?: "section";
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  "data-ui"?: string;
};

export function Card({ title, icon, hint, actions, variant, className, children, ...rest }: Props) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`} aria-label={rest["aria-label"]} data-ui={rest["data-ui"]}>
      {(title || actions) && (
        <div className="panel-head">
          {icon && <Icon name={icon} size={20} />}
          <h2 className={variant === "section" ? "t-label-md upper" : "t-headline-sm"}>{title}</h2>
          {hint && <span className="panel-hint t-label-sm">{hint}</span>}
          {actions}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
