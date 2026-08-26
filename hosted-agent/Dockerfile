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

# Browser libraries an HTML deliverable can inline. A delivered report is
# rendered in a sandbox with no network at all -- no CDN, deliberately, because
# a page that can fetch is a page that can send what it is displaying
# somewhere. So the library has to travel inside the file, and the file cannot
# be built unless the library is already in the image. Pinned by version and
# checked by digest for the same reason the Python runtime is pinned: a rebuild
# must not quietly change what production ships.
ENV DIGIBUDDY_VENDOR_ROOT=/opt/digibuddy/vendor
RUN mkdir -p "$DIGIBUDDY_VENDOR_ROOT" \
    && curl -fsSL https://registry.npmjs.org/echarts/-/echarts-6.1.0.tgz -o /tmp/echarts.tgz \
    && echo "681aff88cc1038c3fa941a3a53d1b177a52250b05335efc607d6105ae13be481  /tmp/echarts.tgz" | sha256sum -c - \
    && tar -xzf /tmp/echarts.tgz -C /tmp package/dist/echarts.min.js \
    && mv /tmp/package/dist/echarts.min.js "$DIGIBUDDY_VENDOR_ROOT/echarts.min.js" \
    && rm -rf /tmp/echarts.tgz /tmp/package \
    && echo "b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0  $DIGIBUDDY_VENDOR_ROOT/echarts.min.js" | sha256sum -c -

COPY hosted-agent /app/hosted-agent

RUN useradd --create-home --shell /bin/bash agent \
    && mkdir -p /workspace /home/agent/.codex \
    && python -c "import sys; from pathlib import Path; s = Path('/app/hosted-agent/skills'); m = {l.strip() for l in (s / '.manifest').read_text().splitlines() if l.strip() and not l.startswith('#')}; f = {p.parent.name for p in s.glob('*/SKILL.md')}; sys.exit(f'packaged skills do not match the manifest: {sorted(m ^ f)}' if m != f else 0)" \
    && PYTHONPATH=/app/hosted-agent/vendor/agent-maturity python -c "import agent_maturity.mcp" \
    && node /app/hosted-agent/skills/superclarity/scripts/superclarity.mjs --help > /dev/null \
    && chown -R agent:agent /workspace /home/agent /app/hosted-agent /opt/digibuddy

ENV HOME=/home/agent

USER agent
WORKDIR /app/hosted-agent

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl --fail http://127.0.0.1:8088/readiness || exit 1

CMD ["python", "main.py"]
