import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          // Silero VAD model files (used by @ricky0123/vad-web)
          src: 'node_modules/@ricky0123/vad-web/dist/silero_*.onnx',
          dest: '.',
          rename: { stripBase: true },
        },
        {
          // Audio worklet bundle (used by @ricky0123/vad-web for AudioWorkletNode)
          src: 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
          dest: '.',
          rename: { stripBase: true },
        },
        {
          // ONNX Runtime Web WASM binary files (used by onnxruntime-web)
          src: 'node_modules/onnxruntime-web/dist/ort-wasm*.wasm',
          dest: '.',
          rename: { stripBase: true },
        },
        {
          // ONNX Runtime Web ESM glue file (used by onnxruntime-web/wasm dynamic import)
          src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
          dest: '.',
          rename: { stripBase: true },
        },
      ],
    }),
  ],
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
