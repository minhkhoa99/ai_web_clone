import { Card } from "@/app/_ui/Card";
import { GridTable } from "@/app/_ui/GridTable";
import { hintFor } from "@/app/_ui/error-hints";
import { errorRows, type TaskView } from "./page-states";

const COLUMNS = [
  { key: "phase", header: "Pha", width: "72px" },
  { key: "key", header: "Trang·section", width: "minmax(0, 1fr)" },
  { key: "code", header: "Mã", width: "160px" },
  { key: "msg", header: "Thông báo", width: "minmax(0, 2fr)" },
  { key: "hint", header: "Gợi ý", width: "minmax(0, 2fr)" },
];

// "Lỗi & cảnh báo" (hardening spec §4): every task (of the <= 2000 loaded + live) with an error code. Hidden when none.
export function ErrorPanel({ tasks }: { tasks: TaskView[] }) {
  const rows = errorRows(tasks);
  if (rows.length === 0) return null;
  return (
    <Card data-ui="ui_progress_error_panel" title={`Lỗi & cảnh báo (${rows.length})`}>
      <GridTable
        label="Lỗi & cảnh báo"
        columns={COLUMNS}
        rows={rows}
        rowKey={(t) => `${t.phase}:${t.key}`}
        rowTone={(t) => (t.status === "failed" ? "danger" : "warn")}
        renderCell={(t, key) => {
          switch (key) {
            case "phase":
              return <span className="mono">{t.phase}</span>;
            case "key":
              return (
                <div className="mono ellipsis" title={t.key}>
                  {t.key}
                </div>
              );
            case "code":
              return <span className={`mono ${t.status === "failed" ? "text-danger" : "text-warn"}`}>{t.errorCode}</span>;
            case "msg":
              return (
                <div className="ellipsis" title={t.errorMsg ?? undefined}>
                  {t.errorMsg ?? "—"}
                </div>
              );
            default:
              return <span className="text-2">{hintFor(t.errorCode) ?? "—"}</span>;
          }
        }}
      />
    </Card>
  );
}
