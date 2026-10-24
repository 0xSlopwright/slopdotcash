FROM docker.io/cloudflare/sandbox:0.12.14@sha256:b8175e89ae5efd83987ffd5056f57c28c390fd5706d42ef70fb669e275248e7b
RUN apt-get update && apt-get install -y --no-install-recommends python3 libseccomp2 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /analysis/work /opt/slop && chown 65534:65534 /analysis/work && chmod 0700 /analysis/work
COPY supervise.py /opt/slop/supervise.py
RUN chmod 0555 /opt/slop/supervise.py
