# An isolated Docker engine for real service lifecycle tests. Never mount the host socket.
FROM rust:1.94-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY apps/daemon ./apps/daemon
COPY packages/api/src/services/catalog ./packages/api/src/services/catalog
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target rm -f target/debug/deps/ephord-* && cargo test --locked --no-run --package ephord && cp $(find target/debug/deps -maxdepth 1 -type f -name 'ephord-*' -perm -111 | head -1) /service-tests
FROM docker:29-dind
RUN apk add --no-cache ca-certificates curl coreutils git && ln -s /usr/local/bin/docker /usr/bin/docker
COPY --from=build /service-tests /service-tests

RUN case "$(uname -m)" in x86_64) arch=x86_64; hash=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb ;; aarch64) arch=arm64; hash=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9 ;; esac && curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-$arch-unknown-linux-musl.tar.gz" -o /tmp/railpack.tgz && echo "$hash  /tmp/railpack.tgz" | sha256sum -c - && tar -xzf /tmp/railpack.tgz -C /tmp railpack && mkdir -p /usr/local/libexec && mv /tmp/railpack /usr/local/libexec/ephor-railpack && rm /tmp/railpack.tgz
