"use client";
import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { IconButton } from "./IconButton";

// The eye only switches type password <-> text on what the user is typing: this input is never given a stored secret.
// The toggle sits outside the <label> so the input's accessible name stays exactly `label`.
type Props = { label: string; hint?: ReactNode; "data-ui"?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id">;

export function PasswordInput({ label, hint, ...props }: Props) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const { "data-ui": ui, ...input } = props;
  return (
    <div className="field-x" data-ui={ui}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <span className="field-control pw">
        <input id={id} type={shown ? "text" : "password"} autoComplete="off" {...input} />
        <IconButton icon={shown ? "visibility_off" : "visibility"} label={shown ? "Ẩn mật khẩu" : "Hiện mật khẩu"} pressed={shown} onClick={() => setShown((s) => !s)} />
      </span>
      {hint && <span className="field-hint t-body-sm">{hint}</span>}
    </div>
  );
}
