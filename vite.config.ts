import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const backendTarget = process.env.VITE_BACKEND_TARGET || 'http://127.0.0.1:4000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
