# Container image for the PDF splitter sidecar.
#
# Deliberately tiny: qpdf does the work, and the service around it is Python
# standard library only, so there is nothing to install from PyPI and no
# dependency surface to keep patched.
#
# `python3`, not `python3-minimal`: minimal ships the interpreter without
# libpython3.11-stdlib, so http.server, json, shutil, urllib and uuid are all
# absent and server.py exits 1 on its import block - which the Worker only
# ever sees as "Failed to start container".
#
# Containers must run on linux/amd64.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        qpdf \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py /app/server.py

ENV PORT=8080
EXPOSE 8080

# -u keeps stdout unbuffered so logs reach `wrangler tail` as they happen.
CMD ["python3", "-u", "/app/server.py"]
