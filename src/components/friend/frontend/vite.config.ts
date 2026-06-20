import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 1420,
    strictPort: false,
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
  build: {
    target: ['es2022', 'chrome100', 'safari16'],
    minify: 'esbuild',
    sourcemap: false,
  },
})
