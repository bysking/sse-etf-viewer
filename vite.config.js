import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { apiMiddleware } from './server/api.js'

// 把后端 API 作为中间件挂进 Vite：
//   npm run dev     → 开发服务器同时提供页面（热更新）和 /api/*
//   npm run preview → 预览构建产物，同样带 /api/*
const sseApi = () => ({
  name: 'sse-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware())
  },
  configurePreviewServer(server) {
    server.middlewares.use(apiMiddleware())
  },
})

export default defineConfig({
  plugins: [react(), sseApi()],
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  // antd + React 体积较大，放宽告警阈值（echarts 已按需引入）
  build: { chunkSizeWarningLimit: 1200 },
})
