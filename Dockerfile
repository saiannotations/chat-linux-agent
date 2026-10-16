// Build the "agent" container image: Debian Trixie + Node 24, plus the
// sandbox-shim helper that @cloudflare/sandbox file operations need.
FROM node:24-trixie-slim

COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip curl git ca-certificates procps iproute2 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace
WORKDIR /workspace

# Keep the container alive; the agent starts real work via exec().
CMD ["sleep", "infinity"]
