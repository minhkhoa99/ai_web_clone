"use client";
import { Icon } from "./Icon";

type Props = { label: string; placeholder: string; value: string; onChange(v: string): void; onSubmit?(): void; "data-ui"?: string };

// Literal substring search: callers filter with includes(), never a RegExp.
export function SearchInput({ label, placeholder, value, onChange, onSubmit, ...ui }: Props) {
  const input = (
    <span className="search-input">
      <Icon name="search" />
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
  if (!onSubmit) return <span data-ui={ui["data-ui"]}>{input}</span>;
  return (
    <form
      role="search"
      data-ui={ui["data-ui"]}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {input}
    </form>
  );
}
