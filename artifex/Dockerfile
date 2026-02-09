# Copyright (c) 2026 Mihai Stancu (https://github.com/curatorium)

# Artifex reads the Scribe's notes and builds
FROM node:22-slim
RUN usermod -l artifex -d /home/artifex -m node && groupmod -n artifex node

ENV DISABLE_AUTOUPDATER=1
ENV NODE_OPTIONS=--max-old-space-size=4096
ENV TERM=xterm-256color

WORKDIR /app
STOPSIGNAL SIGTERM

# Use Steward to install system dependencies
ADD https://github.com/curatorium/steward/releases/latest/download/steward /usr/local/bin/steward
RUN chmod +x /usr/local/bin/steward
COPY Stewardfile ./
RUN steward

COPY entrypoint /usr/local/bin/entrypoint
CMD ["entrypoint"]

# Run as non-root user
RUN mkdir -p /home/artifex/.claude /home/artifex/.ssh && chown -R artifex:artifex /home/artifex/.claude /home/artifex/.ssh
USER artifex
