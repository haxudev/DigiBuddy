FROM python:3.12-slim

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
    && apt-get install -y --no-install-recommends ca-certificates curl git nodejs npm \
    && rm -rf /var/lib/apt/lists/*

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
RUN cd /opt/digibuddy && npm install --omit=dev

COPY hosted-agent /app/hosted-agent

RUN useradd --create-home --shell /bin/bash agent \
    && mkdir -p /workspace /home/agent/.codex \
    && chown -R agent:agent /workspace /home/agent /app/hosted-agent /opt/digibuddy

USER agent
WORKDIR /app/hosted-agent

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl --fail http://127.0.0.1:8088/readiness || exit 1

CMD ["python", "main.py"]
