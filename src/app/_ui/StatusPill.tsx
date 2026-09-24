// queued: waiting in the job queue behind another project (the status is still the pre-run one)
export function StatusPill({ status, queued = false }: { status: string; queued?: boolean }) {
  return (
    <>
      <span className={`pill pill-${status}`}>{status}</span>
      {queued && <span className="pill pill-queued"> đang chờ</span>}
    </>
  );
}
