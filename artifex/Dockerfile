# Copyright (c) 2026 Mihai Stancu (https://github.com/curatorium)

# Artifex reads the Scribe's notes and builds
FROM debian:bookworm-slim
ENV DISABLE_AUTOUPDATER=1
ENV PLATFORM=devcontainer
ENV TERM=xterm-256color

STOPSIGNAL SIGTERM
CMD ["entrypoint"]

# Use Steward to install system dependencies
ADD https://github.com/curatorium/steward/releases/latest/download/steward /usr/local/bin/steward
RUN chmod +x /usr/local/bin/steward
COPY Stewardfile /tmp/Stewardfile
RUN cd /tmp && steward

COPY entrypoint /usr/local/bin/entrypoint

# Prepare non-root user
RUN useradd -m -s /bin/bash -u 1000 artifex
RUN mkdir -p /app /home/artifex/.ssh /home/artifex/.config /home/artifex/.local && chown -R artifex:artifex /app /home/artifex/.ssh /home/artifex/.config /home/artifex/.local
USER artifex
WORKDIR /app
