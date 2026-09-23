// The one allowlist of Host names the app answers to (src/proxy.ts for every path, handle() for the API).
// A loopback-only Host blocks DNS rebinding: evil.test resolving to 127.0.0.1 arrives with Host evil.test.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  const url = URL.parse(`http://${host}`);
  return !!url && LOOPBACK_HOSTS.has(url.hostname);
}
