# Entropicide's container image: the app (gunicorn) and Node.js, which reads tasks typed on
# the Android app (quickadd_server.js). The database, its backups and the secret key live in
# /data: mount a volume there. See docker-compose.yml and README.md.
FROM python:3.13-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# It runs as this account; docker/entrypoint.sh hands /data to it first.
RUN useradd --system --uid 10001 --home-dir /data entropicide \
    && ln -s /app/docker/manage /usr/local/bin/manage
ENTRYPOINT ["/app/docker/entrypoint.sh"]

ENV ENTROPICIDE_DATABASE=/data/entropicide.db \
    ENTROPICIDE_BACKUP_DIR=/data/backups \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000

# (SCRIPT_NAME: the path it's served under, if not the whole site, e.g. /tasks.)
HEALTHCHECK --interval=1m --timeout=5s --start-period=20s \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:8000' + os.environ.get('SCRIPT_NAME', '') + '/login', timeout=4)"

# One worker: reminders, Google sync and sign-in throttling run inside it (threads serve
# requests). SQLite doesn't share well between processes anyway.
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:8000", "app:app"]
