# 使用 Node.js 官方鏡像
FROM node:20-slim

# 設定工作目錄
WORKDIR /app

# 複製 package.json 並安裝依賴
COPY package.json package-lock.json* ./
RUN npm install --production

# 複製其餘代碼
COPY . .

# Cloud Run 預設會傳入 PORT 環境變數
ENV PORT 8080
EXPOSE 8080

# 啟動指令 (對應你 index.js 的進入點)
# 如果是 Cloud Run，通常需要一個簡單的 server 啟動 index.js
CMD [ "node", "index.js" ]
