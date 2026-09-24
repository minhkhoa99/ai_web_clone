import type { ReactNode } from "react";

// The <label> wraps only the label text + the control, so the accessible name is exactly `label`
// (suffix is aria-hidden; hintEnd/hint sit outside the label).
type Props = { label: ReactNode; hint?: ReactNode; hintEnd?: ReactNode; suffix?: string; className?: string; children: ReactNode; "data-ui"?: string };

export function Field({ label, hint, hintEnd, suffix, className, children, ...ui }: Props) {
  return (
    <div className={`field-x${className ? ` ${className}` : ""}`} data-ui={ui["data-ui"]}>
      <label>
        <span className="field-label">{label}</span>
        <span className={`field-control${suffix ? " has-suffix" : ""}`}>
          {children}
          {suffix && (
            <span className="field-suffix t-label-sm" aria-hidden="true">
              {suffix}
            </span>
          )}
        </span>
      </label>
      {hintEnd && <span className="field-hint-end t-label-sm">{hintEnd}</span>}
      {hint && <span className="field-hint t-body-sm">{hint}</span>}
    </div>
  );
}
