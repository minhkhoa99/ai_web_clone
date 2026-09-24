// The export ZIP is a POST (JSON body: the CSRF guard), so it is streamed into a blob and saved via <a download>.
export async function downloadZip(projectId: string, stripIds: boolean): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "zip", stripIds }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new Error(`${err.code ?? res.status}: ${err.message ?? res.statusText}`);
  }
  const href = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href, download: `${projectId}.zip` }).click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000); // after the download has started
}
