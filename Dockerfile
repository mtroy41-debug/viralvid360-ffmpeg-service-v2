FROM node:20-slim

# Install FFmpeg and required libraries
RUN apt-get update && \
    apt-get install -y ffmpeg libavcodec-extra ca-certificates && \
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
