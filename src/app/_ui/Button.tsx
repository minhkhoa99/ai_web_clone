import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Look = {
  variant?: "primary" | "secondary" | "warn" | "danger" | "ghost";
  icon?: IconName;
  iconEnd?: IconName;
  size?: "md" | "lg";
  className?: string;
  children?: ReactNode;
  "data-ui"?: string;
};
type LinkProps = Look & { href: string; title?: string; "aria-current"?: "page" };
type NativeProps = Look & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> & { href?: undefined };
export type ButtonProps = LinkProps | NativeProps;

// Mono label (spec §1.2). type="button" unless the caller says type="submit".
export function Button(props: ButtonProps) {
  const { variant = "secondary", icon, iconEnd, size = "md", className, children } = props;
  const cls = ["btn", `btn-${variant}`, size === "lg" ? "btn-lg" : "", className ?? ""].filter(Boolean).join(" ");
  const px = size === "lg" ? 20 : 16;
  const body = (
    <>
      {icon && <Icon name={icon} size={px} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={px} />}
    </>
  );
  if (props.href !== undefined) {
    return (
      <Link href={props.href} className={cls} title={props.title} aria-current={props["aria-current"]} data-ui={props["data-ui"]}>
        {body}
      </Link>
    );
  }
  const { variant: _v, icon: _i, iconEnd: _e, size: _s, className: _c, children: _ch, href: _h, ...native } = props;
  return (
    <button type="button" {...native} className={cls}>
      {body}
    </button>
  );
}
