# Container image for the PDF splitter sidecar.
#
# Deliberately tiny: qpdf does the work, and the service around it is Python
# standard library only, so there is nothing to install from PyPI and no
# dependency surface to keep patched.
#
# Containers must run on linux/amd64.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        qpdf \
        python3-minimal \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py /app/server.py

ENV PORT=8080
EXPOSE 8080

# -u keeps stdout unbuffered so logs reach `wrangler tail` as they happen.
CMD ["python3", "-u", "/app/server.py"]
