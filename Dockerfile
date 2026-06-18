FROM node:20-slim

# Install Python and pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --break-system-packages yt-dlp

# Create app directory
WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json ./

# Install npm dependencies
RUN npm ci

# Copy app source
COPY . .

# Expose the port
EXPOSE 3000

# Start the app
CMD ["node", "index.js"]
