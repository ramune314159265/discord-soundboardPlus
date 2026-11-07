import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Activity では /.proxy/* が URL Mapping 経由でこのサーバーの /* に転送される。
// 開発時は Vite(5173) が API/WS をローカルの Hono(3000) へ中継する。
export default defineConfig({
  plugins: [react()],
  envDir: '..', // ルートの .env を読む (公開されるのは VITE_ で始まるものだけ)
  server: {
    port: 5173,
    allowedHosts: true, // cloudflared などのトンネルのホスト名を許可
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
})
