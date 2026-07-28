# 使用 Node.js 官方鏡像
# Node 22+, not 20: @supabase/supabase-js 2.111.0 needs a native WebSocket
# global, which Node 20 lacks. Rebuilding on node:20-slim throws
# "Node.js 20 detected without native WebSocket support" at createClient().
FROM node:22-slim

# 設定工作目錄
WORKDIR /app

# 複製 package.json 並安裝依賴
# npm ci, not npm install: installs exactly the lockfile's versions. Without
# this the image contents depend on when it was built, not on what is
# committed — how a rebuild of unchanged code broke production (2026-07-28).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 複製其餘代碼
COPY . .

# Cloud Run 預設會傳入 PORT 環境變數
ENV PORT 8080
EXPOSE 8080

# 啟動指令 (對應你 index.js 的進入點)
# 如果是 Cloud Run，通常需要一個簡單的 server 啟動 index.js
CMD [ "node", "index.js" ]
