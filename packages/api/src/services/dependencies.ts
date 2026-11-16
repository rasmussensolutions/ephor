/** Shared by initial enrollment and deployment repair. Never remove existing runtimes. */
export function deploymentDependencies() {
  return `
# Package managers must not consume the enrollment credentials on stdin.
if [ ! -x /usr/bin/docker ] || [ ! -x /usr/bin/git ] || ! /usr/bin/docker buildx version >/dev/null 2>&1; then
  [ -r /etc/os-release ] || { echo 'Install Docker Engine 28+, Buildx, and Git, then retry.' >&2; exit 1; }
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) ;;
    *) echo 'Automatic dependency installation supports Ubuntu and Debian. Install Docker Engine 28+, Buildx, and Git on this distribution, then retry.' >&2; exit 1 ;;
  esac
  export DEBIAN_FRONTEND=noninteractive
  apt-get update </dev/null
  apt-get install -y --no-remove ca-certificates curl git </dev/null
  if [ ! -x /usr/bin/docker ]; then
    # Do not replace an existing container runtime or incompatible Docker packages.
    for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
      if dpkg-query -W -f='\${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
        echo "Existing $package package requires manual Docker setup. See https://docs.docker.com/engine/install/" >&2; exit 1
      fi
    done
    [ -n "\${VERSION_CODENAME:-}" ] || { echo 'Missing distribution codename.' >&2; exit 1; }
    install -d -m 0755 /etc/apt/keyrings
    curl --fail --silent --show-error --proto '=https' "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<REPO
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
REPO
    chmod 0644 /etc/apt/sources.list.d/docker.sources
    apt-get update </dev/null
    apt-get install -y --no-remove docker-ce docker-ce-cli containerd.io docker-buildx-plugin </dev/null
    systemctl enable --now docker.service
  elif ! /usr/bin/docker buildx version >/dev/null 2>&1; then
    # Keep an existing Docker installation and use its configured package sources.
    apt-get install -y --no-remove docker-buildx-plugin </dev/null || {
      echo 'Install the Buildx plugin for your existing Docker installation, then retry.' >&2; exit 1;
    }
  fi
fi
/usr/bin/docker info >/dev/null || { echo 'Docker is installed but unavailable. Start Docker and retry.' >&2; exit 1; }
docker_version=$(/usr/bin/docker version --format '{{.Server.Version}}')
docker_major=\${docker_version%%.*}
case "$docker_major" in ''|*[!0-9]*) echo 'Cannot determine Docker Engine version.' >&2; exit 1 ;; esac
[ "$docker_major" -ge 28 ] || { echo 'Upgrade Docker Engine to version 28 or newer, then retry.' >&2; exit 1; }
/usr/bin/docker buildx version >/dev/null
`;
}
