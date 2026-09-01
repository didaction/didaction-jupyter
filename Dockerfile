FROM ghcr.io/astral-sh/uv:0.9.9-python3.12-bookworm-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY services ./services
ENV PATH="/app/.venv/bin:$PATH"
