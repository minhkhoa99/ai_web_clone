"use client";
import { Icon } from "./Icon";

type Props = { label: string; placeholder: string; value: string; onChange(v: string): void; onSubmit?(): void; "data-ui"?: string };

// Literal substring search: callers filter with includes(), never a RegExp.
// The class carrying the visual style (`.search-input`) sits on the same element as `data-ui`,
// so it fills its container width with no extra wrapper span diluting the layout.
export function SearchInput({ label, placeholder, value, onChange, onSubmit, ...ui }: Props) {
  const body = (
    <>
      <Icon name="search" />
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
  if (!onSubmit)
    return (
      <span className="search-input" data-ui={ui["data-ui"]}>
        {body}
      </span>
    );
  return (
    <form
      role="search"
      className="search-input"
      data-ui={ui["data-ui"]}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {body}
    </form>
  );
}
