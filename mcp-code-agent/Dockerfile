# Needs more than the other two sidecars: this one runs Claude Code against the
# real repository and then runs deploy.sh, so it needs git, the docker CLI (to
# talk to the mounted host socket) and ripgrep (which Claude Code's search uses).
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg ripgrep procps \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# The agent itself.
RUN npm install -g @anthropic-ai/claude-code

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# git refuses to operate in a directory owned by a different uid, which the
# bind-mounted repo is. This is a single-operator box and that mount is the whole
# point of the container, so declare it safe rather than fighting the uid.
#
# The identity matters: every commit this container makes is authored by
# "LibreChat code-agent", so `git log --author` separates what a model changed
# from what a person did, forever, without anyone having to maintain a list.
# ...and it has to be set for BOTH uids. The wrapper runs as root (it needs the
# docker socket for deploy.sh) while the agent itself is dropped to `node`,
# because Claude Code refuses --dangerously-skip-permissions as root. Configure
# only /root and the agent's own commits fail with "please tell me who you are".
RUN git config --global --add safe.directory '*' \
 && git config --global user.name 'LibreChat code-agent' \
 && git config --global user.email 'code-agent@librechat.local' \
 && su node -s /bin/sh -c "git config --global --add safe.directory '*' \
      && git config --global user.name 'LibreChat code-agent' \
      && git config --global user.email 'code-agent@librechat.local'" \
 && mkdir -p /home/node/.claude && chown -R node:node /home/node

EXPOSE 3015
CMD ["node", "index.js"]
