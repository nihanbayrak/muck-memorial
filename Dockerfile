FROM node:20-slim

# Install ImageMagick for HEIC→JPEG conversion on Linux
RUN apt-get update && \
    apt-get install -y --no-install-recommends imagemagick libheif-examples && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Create data directory (will be overridden by persistent disk mount)
RUN mkdir -p /data/uploads

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
