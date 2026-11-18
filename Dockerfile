# Pinned by digest so Dependabot opens a PR (and CI rebuilds) whenever node:26-alpine is updated
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

RUN apk add --no-cache su-exec

WORKDIR /app
ENV NODE_ENV=production PORT=80

# The app runs as a regular user but still listens on port 80, so existing port mappings
# keep working: give node just the "bind ports below 1024" capability
RUN apk add --no-cache --virtual .setcap libcap-utils \
    && setcap cap_net_bind_service=+ep "$(command -v node)" \
    && apk del .setcap

COPY package.json server.js entrypoint.sh LICENSE ./
COPY lib ./lib
COPY public ./public
RUN chmod +x entrypoint.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Unraid reads these for the Docker tab: the icon, and the WebUI button. [PORT:80] becomes
# whichever host port is mapped to the container's port 80.
LABEL net.unraid.docker.icon="https://raw.githubusercontent.com/Aerowinder/jembex-dedupe/main/public/logo.png" \
      net.unraid.docker.webui="http://[IP]:[PORT:80]/"

ENTRYPOINT ["./entrypoint.sh"]
