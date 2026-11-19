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
  build: {
    // 第三方库拆成独立 chunk：改动业务代码时不会让用户重新下载整个包，
    // 且这些库长期不变，缓存命中率更高。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts'
          if (id.includes('@ant-design/icons')) return 'antd-icons'
          if (id.includes('antd') || id.includes('@ant-design') || id.includes('rc-')) return 'antd'
          if (id.includes('react') || id.includes('scheduler')) return 'react'
          return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
})
