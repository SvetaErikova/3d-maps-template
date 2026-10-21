import { defineConfig } from 'vite';

export default defineConfig({
  // Keeps the production build usable from a subdirectory too.
  base: './',
  server: {
    allowedHosts: ['terminal.local'],
  },
});
