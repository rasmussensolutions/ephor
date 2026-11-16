FROM rust:1.94-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY apps/daemon ./apps/daemon
COPY packages/api/src/services/catalog ./packages/api/src/services/catalog
ARG EPHOR_BUILD_ID=development
ENV EPHOR_BUILD_ID=$EPHOR_BUILD_ID
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target cargo build --locked --release --package ephord && cp target/release/ephord /ephord

FROM scratch
COPY --from=build /ephord /ephord
