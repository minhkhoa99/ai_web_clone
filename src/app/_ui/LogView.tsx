import type { ReactNode, Ref, UIEvent } from "react";

export type LogLine = { n: number; at: number; level: "info" | "warn" | "error"; text: string };

// Local wall clock of the server's `at` stamp: "14:22:01.104".
export function clock(at: number): string {
  const d = new Date(at);
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

type Props = { lines: LogLine[]; wrap: boolean; empty: ReactNode; ref?: Ref<HTMLDivElement>; onScroll?(e: UIEvent<HTMLDivElement>): void; lineUi?: string; "data-ui"?: string };

export function LogView({ lines, wrap, empty, ref, onScroll, lineUi, ...ui }: Props) {
  return (
    <div ref={ref} className={`log-view${wrap ? " wrap" : ""}`} role="log" aria-live="polite" onScroll={onScroll} data-ui={ui["data-ui"]}>
      {lines.length === 0 && <span className="log-empty">{empty}</span>}
      {lines.map((l) => (
        <div key={l.n} className={`log-line log-${l.level}`} data-ui={lineUi}>
          <span className="log-time">[{clock(l.at)}]</span> <span className="log-level">[{l.level.toUpperCase()}]</span> {l.text}
        </div>
      ))}
    </div>
  );
}
