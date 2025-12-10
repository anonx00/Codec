# Backend Dockerfile for CODEC AI Caller
FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY . .

# Expose port
EXPOSE 8080

# Run the server
CMD ["node", "server.js"]
