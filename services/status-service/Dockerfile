FROM node:22-slim
WORKDIR /app
COPY server.js .
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.js"]
