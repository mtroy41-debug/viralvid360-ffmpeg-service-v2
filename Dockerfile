# Use official Node.js 18 image
FROM node:18-slim

# Install FFmpeg and dependencies
# `libavcodec-extra` is important for full codec support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libavcodec-extra \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies (only production dependencies)
RUN npm install --production

# Copy application code
COPY . .

# Expose port (as per Railway requirements)
EXPOSE 8080

# Start the application
CMD ["node", "server.js"]
