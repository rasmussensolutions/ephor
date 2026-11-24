# Disposable systemd host with no Node, Bun or Docker installed.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y systemd systemd-sysv dbus ca-certificates curl jq openssl xxd iproute2 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
