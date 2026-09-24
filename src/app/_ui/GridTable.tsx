import type { ReactNode } from "react";

type Column = { key: string; header: ReactNode; width: string };
type Props<R> = {
  label: string;
  columns: Column[];
  rows: R[];
  rowKey(r: R): string;
  renderCell(r: R, key: string): ReactNode;
  rowTone?(r: R): "warn" | "danger" | undefined;
  rowProps?(r: R): { className?: string; "data-ui"?: string };
  empty?: ReactNode;
  "data-ui"?: string;
};

// ARIA table on divs (CSS grid rows): header band + rows, row tone = 5% warn/danger tint.
export function GridTable<R>({ label, columns, rows, rowKey, renderCell, rowTone, rowProps, empty, ...ui }: Props<R>) {
  const template = { gridTemplateColumns: columns.map((c) => c.width).join(" ") };
  return (
    <div role="table" aria-label={label} className="grid-table" data-ui={ui["data-ui"]}>
      <div role="rowgroup">
        <div role="row" className="grid-row grid-head" style={template}>
          {columns.map((c) => (
            <div role="columnheader" key={c.key}>
              {c.header}
            </div>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {rows.map((r) => {
          const tone = rowTone?.(r);
          const extra = rowProps?.(r);
          const cls = ["grid-row", tone ? `row-${tone}` : "", extra?.className ?? ""].filter(Boolean).join(" ");
          return (
            <div role="row" key={rowKey(r)} className={cls} style={template} data-ui={extra?.["data-ui"]}>
              {columns.map((c) => (
                <div role="cell" key={c.key}>
                  {renderCell(r, c.key)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && empty}
    </div>
  );
}
