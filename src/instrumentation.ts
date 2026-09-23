// Runs once per server process. Interrupted jobs are only marked (never auto-run): the user presses Resume.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ getDb }, { recoverOnStartup }] = await Promise.all([import("./app/_server/db"), import("./core/jobs")]);
  recoverOnStartup(getDb());
}
