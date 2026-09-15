import { defineConfig } from 'vite';
export default defineConfig({ base: process.env.PLAYGROUND_BASE || '/', build: { target: 'es2022' } });
