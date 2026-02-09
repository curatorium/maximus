# Copyright (c) 2026 Mihai Stancu (https://github.com/curatorium)

# Scribe listens to Discord and takes notes
FROM node:22-slim
RUN usermod -l scribe -d /home/scribe -m node && groupmod -n scribe node

WORKDIR /app
STOPSIGNAL SIGTERM

# Use Steward to install system dependencies
ADD https://github.com/curatorium/steward/releases/latest/download/steward /usr/local/bin/steward
RUN chmod +x /usr/local/bin/steward
COPY Stewardfile ./
RUN steward

# Install Node dependencies
COPY package*.json ./
RUN npm install

COPY . .

# Run as non-root user
USER scribe
CMD ["npm", "start"]
