import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true, // 允許同網段手機連進來測試
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/images': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
