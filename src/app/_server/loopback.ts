// The one allowlist of Host names the app answers to (src/proxy.ts for every path, handle() for the API).
// A loopback-only Host blocks DNS rebinding: evil.test resolving to 127.0.0.1 arrives with Host evil.test.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Bare host[:port] only: URL.parse alone accepts "127.0.0.1/x;y" or "evil@localhost", and the Host ends up in URLs
// (the editor canvas CSP), so path / userinfo / query / space / `;` are refused before parsing.
const HOST_CHARS = /^[A-Za-z0-9.\-:[\]]+$/;

export function isLoopbackHost(host: string): boolean {
  if (!HOST_CHARS.test(host)) return false;
  const url = URL.parse(`http://${host}`);
  return !!url && LOOPBACK_HOSTS.has(url.hostname);
}
