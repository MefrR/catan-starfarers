# Catan: Starfarers — production image for Fly.io (or any container host).
# Single stage: install the whole workspace, build (shared → client/dist →
# server/dist/index.mjs), then prune dev deps so the runtime image only carries
# express + socket.io. The server serves the built client from client/dist.
FROM node:20-slim

WORKDIR /app

# Install ALL workspace deps first (incl. dev — tsc/vite/esbuild) so the build can
# run. NOTE: do NOT set NODE_ENV=production yet — npm would skip devDependencies
# and the build tools would be missing (exit 127). Copying the manifests + lockfile
# before the source keeps this layer cached across code-only changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

# Bring in the source and build everything, then drop dev deps to slim the image.
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime only: NODE_ENV=production now (after the build). The server reads PORT
# from the environment (Fly injects it) and binds 0.0.0.0.
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/dist/index.mjs"]
