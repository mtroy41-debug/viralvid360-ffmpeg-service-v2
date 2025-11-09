# Use official Node.js 18 image
FROM node:18-slim

# Install FFmpeg and codecs
RUN apt-get update && \
    apt-get install -y ffmpeg libavcodec-extra && \
    rm -rf /var/lib/apt/lists/*

# Workdir
WORKDIR /app

# Install deps first
COPY package*.json ./
RUN npm install --production

# Copy app
COPY . .

# Make sure /tmp is writable for ffmpeg
RUN mkdir -p /tmp && chmod -R 777 /tmp

# Railway port
EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]
