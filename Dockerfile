# Use official Node.js 18 image
FROM node:18-slim

# Install FFmpeg and required codecs
RUN apt-get update && \
    apt-get install -y ffmpeg libavcodec-extra && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first (better build cache)
COPY package*.json ./

# Install dependencies (production mode)
RUN npm install --production

# Copy the rest of the application
COPY . .

# Ensure /tmp is writable (for FFmpeg temp files)
RUN mkdir -p /tmp && chmod -R 777 /tmp

# Railway requires a listening port
EXPOSE 8080

# Define environment vars defaults (optional)
ENV NODE_ENV=production
ENV PORT=8080

# Start service
CMD ["node", "server.js"]
