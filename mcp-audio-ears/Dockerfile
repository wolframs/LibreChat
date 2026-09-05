# ffmpeg and python3 both have to be here: the MCP surface is Node (mirroring
# mcp-image-gen), but the listening itself is describe_audio.py, which shells out
# to ffmpeg/ffprobe for transcode, shrink and chunk-splitting. node:20-alpine
# would need a separate python3 + ffmpeg build; bookworm-slim has both as apt
# packages and the image is only ~200MB larger.
FROM node:20-bookworm-slim
WORKDIR /app
# ca-certificates is not optional: python's urllib does its own TLS verification
# and bookworm-slim ships no trust store, so every call to openrouter.ai fails
# with CERTIFICATE_VERIFY_FAILED. Node bundles its own roots and would not have
# shown this.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3014
CMD ["node", "index.js"]
