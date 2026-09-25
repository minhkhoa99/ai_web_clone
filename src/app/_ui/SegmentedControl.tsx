"use client";
import type { KeyboardEvent, ReactNode } from "react";
import { Badge } from "./Badge";
import { Icon, type IconName } from "./Icon";

export type SegOption<T extends string> = { value: T; label: ReactNode; icon?: IconName; count?: number; disabled?: boolean; tone?: "warn" };
type Props<T extends string> = {
  label: string;
  options: SegOption<T>[];
  value: T;
  onChange(v: T): void;
  semantics?: "toggle" | "tabs";
  full?: boolean;
  "data-ui"?: string;
  /** id of a visible heading to use as the group's accessible name instead of `label` (which is still required, e.g. for callers with no visible heading). */
  "aria-labelledby"?: string;
};

// toggle: role=group + aria-pressed. tabs: role=tablist/tab + aria-selected, ←/→ move between enabled tabs.
export function SegmentedControl<T extends string>({ label, options, value, onChange, semantics = "toggle", full = false, ...ui }: Props<T>) {
  const tabs = semantics === "tabs";
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tabs || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div
      role={tabs ? "tablist" : "group"}
      aria-label={ui["aria-labelledby"] ? undefined : label}
      aria-labelledby={ui["aria-labelledby"]}
      className={`seg${tabs ? " seg-tabs" : ""}${full ? " seg-full" : ""}`}
      onKeyDown={onKey}
      data-ui={ui["data-ui"]}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-value={o.value}
            disabled={o.disabled}
            className={`seg-item${o.tone ? ` tone-${o.tone}` : ""}`}
            {...(tabs ? { role: "tab", "aria-selected": on, tabIndex: on ? 0 : -1 } : { "aria-pressed": on })}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} />}
            {o.label}
            {o.count !== undefined && <Badge tone={on ? "accent" : "neutral"}>{o.count}</Badge>}
          </button>
        );
      })}
    </div>
  );
}
