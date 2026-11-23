FROM rust:1.94-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY apps/daemon ./apps/daemon
COPY packages/api/src/services/catalog ./packages/api/src/services/catalog
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target cargo test --locked --no-run --package ephord && cp $(find target/debug/deps -maxdepth 1 -type f -name 'ephord-*' -perm -111 | head -1) /protection-tests
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates systemd procps && mkdir -p /run/systemd/system /etc/systemd/system && touch /etc/systemd/system/ephor-updates-apply.service
COPY deploy/daemon/updates-test-systemctl /usr/bin/systemctl
RUN chmod 755 /usr/bin/systemctl && printf '#!/bin/sh\nexit 0\n' > /usr/bin/loginctl && chmod 755 /usr/bin/loginctl
COPY --from=build /protection-tests /protection-tests
CMD ["/protection-tests", "protections::updates::tests::linux_update_lifecycle", "--ignored", "--nocapture", "--test-threads=1"]
