# Reuses the isolated nested-Docker test runner, never the host Docker socket.
FROM ephor-services-test
RUN case "$(uname -m)" in x86_64) arch=64bit ;; aarch64) arch=ARM64 ;; esac && \
    base=https://github.com/aquasecurity/trivy/releases/download/v0.76.2 && \
    curl -fsSL "$base/trivy_0.76.2_checksums.txt" -o /tmp/checksums && \
    echo '802e4ac1418ed967cd3c4b901f4f71ca00b7363ede67778665a22d9f13f58c83  /tmp/checksums' | sha256sum -c - && \
    asset="trivy_0.76.2_Linux-$arch.tar.gz" && \
    curl -fsSL "$base/$asset" -o "/tmp/$asset" && \
    (cd /tmp && awk -v name="$asset" '$2 == name { print }' checksums | sha256sum -c - && tar -xzf "$asset" trivy) && \
    mv /tmp/trivy /usr/local/libexec/ephor-trivy && rm /tmp/checksums "/tmp/$asset"
