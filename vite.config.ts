import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const packageManifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  base: process.env.PLAYGROUND_BASE || '/',
  define: {
    __PLAYGROUND_VERSION__: JSON.stringify(process.env.PLAYGROUND_VERSION || packageManifest.version),
  },
  build: { target: 'es2022' },
});
