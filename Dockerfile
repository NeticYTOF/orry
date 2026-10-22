# Orry runs on Bun (it uses bun:sqlite and runs TypeScript directly), so the
# runtime is pinned here rather than left to Railway's builder detection.
FROM oven/bun:1.3.13

# Railway volumes mount owned by root, so the bot runs as root to be able to
# create rivet.db on it.
USER root

WORKDIR /app

# Dependencies in their own layer so editing lib/ doesn't re-resolve them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Slack connects over Socket Mode, so no port or healthcheck is needed for it.
CMD ["bun", "index.ts"]
