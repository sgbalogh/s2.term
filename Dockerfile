# Use Debian as the base image
FROM debian:bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    ca-certificates \
    locales \
    vim \
    btop \
    htop \
    iotop \
    unzip \
    procps \
    tmux \
    && rm -rf /var/lib/apt/lists/*


RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && \
    locale-gen
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

ENV TERM=xterm-256color

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

RUN cargo install streamstore-cli

# Set working directory
WORKDIR /app

# Copy Cargo files first for better layer caching
COPY rust-pty-host/Cargo.toml rust-pty-host/Cargo.lock ./

# Copy source code
COPY rust-pty-host/src ./src

# Build the application
RUN cargo build --release


# Set the entrypoint to the built binary
ENTRYPOINT ["./target/release/s2term-pty-host"]