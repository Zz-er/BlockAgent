// Where the SessionProtocol WS host (packages/server) lives. Overridable at build
// time via VITE_WS_URL; defaults to the same host on the conventional dev port.
const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;

export const WS_URL: string =
  fromEnv ??
  (() => {
    if (typeof window === 'undefined') return 'ws://localhost:4317';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // dev default: server on :4317 regardless of the Vite dev port.
    return `${proto}//${window.location.hostname}:4317`;
  })();

/** How long a changed card stays flashed before fading back (§4.5). */
export const HIGHLIGHT_FADE_MS = 1500;
