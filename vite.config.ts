import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const plugins = [react(), tailwindcss()];
  try {
    // @ts-expect-error - .vite-source-tags.js is an untyped injected helper
    const m = await import('./.vite-source-tags.js');
    plugins.push(m.sourceTags());
  } catch {
    /* source tags unavailable — proceed without them */
  }

  const env = loadEnv(mode, process.cwd(), ['VITE_', 'NEXT_PUBLIC_']);
  const processEnvDefines: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    processEnvDefines[`process.env.${key}`] = JSON.stringify(value);
  }

  return {
    plugins,
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: processEnvDefines,
    server: {
      host: true,
      allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
      // The browser never talks to the Python service directly — everything
      // goes through /api so the app works unchanged behind a remote preview.
      proxy: {
        '/api': {
          target: env.VITE_UMBRA_BACKEND || 'http://127.0.0.1:8000',
          changeOrigin: true,
          // generation can take minutes on CPU
          timeout: 15 * 60 * 1000,
          proxyTimeout: 15 * 60 * 1000,
        },
      },
    },
  };
})
