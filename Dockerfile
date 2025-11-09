FROM node:18-slim

RUN apt-get update && \
    apt-get install -y ffmpeg libavcodec-extra && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

RUN mkdir -p /tmp && chmod -R 777 /tmp

EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]
