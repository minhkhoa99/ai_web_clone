import type { ReactNode } from "react";
import { Icon } from "./Icon";

export function Disclosure({ summary, defaultOpen = false, className, children, ...ui }: { summary: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode; "data-ui"?: string }) {
  return (
    <details className={`disclosure${className ? ` ${className}` : ""}`} open={defaultOpen} data-ui={ui["data-ui"]}>
      <summary>
        <Icon name="chevron_right" className="disclosure-chevron" />
        {summary}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
