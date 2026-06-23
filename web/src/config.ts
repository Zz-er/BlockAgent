// Where the SessionProtocol WS host (packages/server) lives.
//
// Resolution order:
//   1. PLATFORM EMBED — when served under the BlockAI platform BFF at `/inspect-ui/?instance=<name>`,
//      dial the BFF's SAME-ORIGIN inspector bridge `/api/inspect/<name>`. The BFF whitelist-resolves
//      `<name>` against its fleet into the internal serve WS — so `instance` is a LABEL, never a URL
//      (no `?url=` open-redirect / XSS-to-arbitrary-WS). This is the only cross-origin-safe handle.
//   2. VITE_WS_URL — explicit build-time override (standalone deploys).
//   3. dev default — same host on the conventional :4317 serve port.
export const WS_URL: string = (() => {
  if (typeof window !== 'undefined') {
    const instance = new URLSearchParams(window.location.search).get('instance');
    if (instance !== null && instance !== '') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/api/inspect/${encodeURIComponent(instance)}`;
    }
  }
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv !== undefined) return fromEnv;
  if (typeof window === 'undefined') return 'ws://localhost:4317';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.hostname}:4317`;
})();

/** How long a changed card stays flashed before fading back (§4.5). */
export const HIGHLIGHT_FADE_MS = 1500;
