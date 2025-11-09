FROM node:18-slim

RUN apt-get update && \
    apt-get install -y ffmpeg libavcodec-extra && \
    # REMOVED: apt-get install -y /usr/lib/x86_64-linux-gnu/libssl* \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY . .

RUN mkdir -p /tmp && chmod 777 /tmp

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]
