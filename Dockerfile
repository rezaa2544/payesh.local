# پایش — تصویر داکر برای استقرار روی هر میزبان همیشه‌روشن
# ساخت:  docker build -t payesh .
# اجرا:   docker run -d -p 8080:8080 -v payesh-data:/data --name payesh payesh
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    PAYESH_DATA=/data \
    PAYESH_TUNNEL_AUTO=0

WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "server/index.js"]
