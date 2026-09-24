import type { SVGProps } from "react";
import { ICONS, type IconName } from "./icons.gen";

export type { IconName };

type Props = { name: IconName; size?: 14 | 16 | 20; className?: string } & Omit<SVGProps<SVGSVGElement>, "name" | "className">;

// Always decorative (aria-hidden): a control that is only an icon names itself (IconButton's required label).
export function Icon({ name, size = 16, className, ...rest }: Props) {
  return (
    <svg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      {...rest}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
