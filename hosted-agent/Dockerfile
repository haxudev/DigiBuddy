FROM node:22.14.0-bookworm-slim AS node-runtime

FROM python:3.12.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8088 \
    CODEX_HOME=/home/agent/.codex \
    CODEX_WORKSPACE=/workspace \
    DIGIBUDDY_PAYLOAD_ROOT=/opt/digibuddy \
    PYTHONPATH=/opt/digibuddy/tools \
    PATH=/opt/digibuddy/node_modules/.bin:$PATH

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 20 || (major === 20 && minor < 10)) process.exit(1)'

COPY hosted-agent/requirements.txt /app/requirements.txt
COPY src/requirements.txt /app/payload-requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt \
    && python -m pip install --no-cache-dir -r /app/payload-requirements.txt

COPY hosted-agent/package.json hosted-agent/package-lock.json /app/codex/
RUN cd /app/codex \
    && npm ci --omit=dev \
    && ln -s /app/codex/node_modules/.bin/codex /usr/local/bin/codex

# Agent payload: persona, tools (Azure Blob, SharePoint, M365), skills and MCP catalogue.
COPY src /opt/digibuddy
RUN cd /opt/digibuddy && npm ci --omit=dev

COPY hosted-agent /app/hosted-agent

RUN useradd --create-home --shell /bin/bash agent \
    && mkdir -p /workspace /home/agent/.codex \
    && python -c "import sys; from pathlib import Path; s = Path('/app/hosted-agent/skills'); m = {l.strip() for l in (s / '.manifest').read_text().splitlines() if l.strip() and not l.startswith('#')}; f = {p.parent.name for p in s.glob('*/SKILL.md')}; sys.exit(f'packaged skills do not match the manifest: {sorted(m ^ f)}' if m != f else 0)" \
    && PYTHONPATH=/app/hosted-agent/vendor/agent-maturity python -c "import agent_maturity.mcp" \
    && chown -R agent:agent /workspace /home/agent /app/hosted-agent /opt/digibuddy

ENV HOME=/home/agent

USER agent
WORKDIR /app/hosted-agent

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl --fail http://127.0.0.1:8088/readiness || exit 1

CMD ["python", "main.py"]
