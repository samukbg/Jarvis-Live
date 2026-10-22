import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backendTarget = process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:4000'

// ONNX Runtime's WebAssembly (the on-device "Hey Jarvis" model, src/runtime/wake) is served by
// Jarvis itself, not a CDN: dev serves it from node_modules, the build copies it to
// ort/<version>/ (versioned: browsers cache it for good). Only the plain SIMD build (CPU,
// 13.6 MB) — the wake model is tiny and runs in a worker.
const require = createRequire(import.meta.url)
const ORT_DIR = path.dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'))
const ORT_VERSION: string = JSON.parse(fs.readFileSync(path.join(ORT_DIR, '..', 'package.json'), 'utf8')).version
const ORT_BASE = `ort/${ORT_VERSION}/`
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']

function onnxRuntimeFiles(): Plugin {
  return {
    name: 'jarvis-onnx-runtime-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const p = (req.url || '').split('?')[0]
        const file = p.startsWith(`/${ORT_BASE}`) ? p.slice(ORT_BASE.length + 1) : ''
        if (!ORT_FILES.includes(file)) return next()
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        fs.createReadStream(path.join(ORT_DIR, file)).pipe(res)
      })
    },
    generateBundle() {
      for (const file of ORT_FILES) this.emitFile({ type: 'asset', fileName: `${ORT_BASE}${file}`, source: fs.readFileSync(path.join(ORT_DIR, file)) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), onnxRuntimeFiles()],
  define: { 'import.meta.env.VITE_ORT_BASE': JSON.stringify(ORT_BASE) },
  resolve: {
    // transformers.js imports the WebGPU build of ONNX Runtime; the wake model runs on the CPU
    // build that loads its WebAssembly from ort/<version>/ (no 25 MB asyncify copy, no WebGPU code).
    alias: [{ find: /^onnxruntime-web\/webgpu$/, replacement: path.join(ORT_DIR, 'ort.wasm.min.mjs') }],
  },
  // Module workers (the wake model's worker loads ONNX Runtime with dynamic imports).
  worker: { format: 'es' },
  // Pre-bundled up front: found late (in the worker), it would reload the dev page.
  optimizeDeps: { include: ['@huggingface/transformers'] },
  server: {
    port: 11433,
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
      '/avatars': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/ice-servers': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/offer': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/probe-offer': {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
})
