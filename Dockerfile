FROM ghcr.io/astral-sh/uv:0.9.9-python3.12-bookworm-slim AS runtime
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY services ./services
ENV PATH="/app/.venv/bin:$PATH"
RUN useradd --create-home --uid 1000 notebook
USER notebook

FROM node:22.18.0-bookworm AS node
FROM rust:1.96.0-bookworm AS frontend
ENV CARGO_BUILD_JOBS=1
COPY --from=node /usr/local/ /usr/local/
WORKDIR /build
RUN npm install --global pnpm@10.15.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY web ./web
COPY vite.config.ts tsconfig.json ./
ARG DIDACTION_BUILD_GIT_SHA=unknown
ARG DIDACTION_BUILD_DIRTY=unknown
ENV DIDACTION_BUILD_GIT_SHA=$DIDACTION_BUILD_GIT_SHA DIDACTION_BUILD_DIRTY=$DIDACTION_BUILD_DIRTY
RUN pnpm build

FROM runtime AS gateway-prebuilt
COPY dist /app/dist
ENV DIDACTION_STATIC_DIR=/app/dist
CMD ["uvicorn", "services.gateway.app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]

FROM runtime AS gateway
COPY --from=frontend /build/dist /app/dist
ENV DIDACTION_STATIC_DIR=/app/dist
CMD ["uvicorn", "services.gateway.app.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
