FROM rust:1.94-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY apps/daemon ./apps/daemon
COPY packages/api/src/services/catalog ./packages/api/src/services/catalog
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target cargo test --locked --no-run --package ephord && cp $(find target/debug/deps -maxdepth 1 -type f -name 'ephord-*' -perm -111 | head -1) /protection-tests
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl nftables openssh-server systemd procps iproute2 python3 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
# The test exercises real CrowdSec/nftables; only service lifecycle is emulated inside the disposable container.
COPY deploy/daemon/protections-test-systemctl /usr/bin/systemctl
RUN chmod 755 /usr/bin/systemctl
COPY --from=build /protection-tests /protection-tests
