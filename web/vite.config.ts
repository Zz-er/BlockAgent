import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web inspector is a pure client bundle. The WS host (packages/server) is a
// separate workspace; in dev we point at it via VITE_WS_URL (see src/config.ts),
// so there is no Vite proxy needed for the socket — the client dials it directly.
export default defineConfig({
  plugins: [react()],
  // Asset base. Standalone = '/'. When embedded under the platform BFF at /inspect-ui/, build with
  // `VITE_BASE=/inspect-ui/ npm run build -w @block-agent/web` so emitted asset URLs resolve there.
  base: process.env['VITE_BASE'] ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
