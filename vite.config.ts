import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any static host path
  // (GitHub Pages project sites, Netlify, a subdirectory, etc.)
  base: './',
  build: {
    target: 'es2020',
    // Keep the bundle inspectable; it is small anyway.
    sourcemap: true,
  },
  // vitest picks this up too
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as any);
