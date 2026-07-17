# baby-pool — a tiny single-container Flask app that serves a read-only,
# shared-password-gated page for a baby birth-date guessing pool.
# Stateless except for the gitignored data/entries.json snapshot, which is
# mounted in from the box (the Sheet is the source of truth; Hopper syncs it).
FROM python:3.12-slim

# Non-root runtime user.
RUN useradd --create-home --uid 10001 babypool

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY babypool/ ./babypool/

# The entries.json snapshot is mounted here from the box at runtime (see
# docker-compose.yml). Keep the dir present so the app starts even before the
# first sync (it renders an empty pool rather than crashing).
ENV BABYPOOL_DATA=/app/data \
    PYTHONUNBUFFERED=1

RUN mkdir -p /app/data && chown -R babypool:babypool /app

USER babypool
EXPOSE 8080

CMD ["gunicorn", "--workers", "2", "--threads", "4", \
     "--bind", "0.0.0.0:8080", "--timeout", "30", \
     "--access-logfile", "-", "babypool.web:create_app()"]
