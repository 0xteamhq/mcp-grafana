FROM node:22-alpine

WORKDIR /app

# Install curl for the entrypoint health-check + token provisioning
RUN apk add --no-cache curl

# Copy built dist and package files
COPY package.json ./
COPY dist ./dist

# Install production dependencies only
RUN npm install --omit=dev --ignore-scripts

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
