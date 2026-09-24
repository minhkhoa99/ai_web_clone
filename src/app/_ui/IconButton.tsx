import Link from "next/link";
import type { ButtonHTMLAttributes, Ref } from "react";
import { Icon, type IconName } from "./Icon";

type Base = { icon: IconName; label: string; tone?: "default" | "danger" | "success" | "warn"; className?: string; "data-ui"?: string };
type LinkProps = Base & { href: string; external?: boolean; current?: boolean };
type NativeProps = Base &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className" | "title" | "aria-label"> & { href?: undefined; pressed?: boolean; ref?: Ref<HTMLButtonElement> };

// 28×28 ghost button. `label` is required: it becomes aria-label AND title (spec §1.5).
export function IconButton(props: LinkProps | NativeProps) {
  const cls = ["icon-btn", props.tone && props.tone !== "default" ? `tone-${props.tone}` : "", props.className ?? ""].filter(Boolean).join(" ");
  const svg = <Icon name={props.icon} />;
  if (props.href !== undefined) {
    const common = { className: cls, "aria-label": props.label, title: props.label, "data-ui": props["data-ui"] };
    return props.external ? (
      <a href={props.href} target="_blank" rel="noopener noreferrer" {...common}>
        {svg}
      </a>
    ) : (
      <Link href={props.href} aria-current={props.current ? "page" : undefined} {...common}>
        {svg}
      </Link>
    );
  }
  const { icon: _i, label, tone: _t, className: _c, href: _h, pressed, ...native } = props;
  return (
    <button type="button" {...native} className={cls} aria-label={label} title={label} aria-pressed={pressed}>
      {svg}
    </button>
  );
}
