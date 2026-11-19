# Reproducible Linux x86_64 build image targeting glibc 2.28 (Debian 10 Buster)
# for UOS 20, Kylin, and Debian 10 workstations (#601).
FROM debian:10-slim

ENV DEBIAN_FRONTEND=noninteractive

# Debian 10 Buster moved to archive.debian.org
RUN sed -i 's|deb.debian.org/debian|archive.debian.org/debian|g; s|security.debian.org/debian-security|archive.debian.org/debian-security|g; /buster-updates/d' /etc/apt/sources.list \
  && apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends \
       build-essential curl ca-certificates git pkg-config libssl-dev \
       libwebkit2gtk-4.1-dev || apt-get install -y --no-install-recommends libwebkit2gtk-4.0-dev \
       libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf file xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (glibc 2.28 compatible) + pnpm
RUN curl -fsSL https://unofficial-builds.nodejs.org/download/release/v20.18.0/node-v20.18.0-linux-x64-glibc-217.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1 \
  && npm install -g pnpm@10

# Install Rust stable toolchain
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal

WORKDIR /workspace
CMD ["bash"]
