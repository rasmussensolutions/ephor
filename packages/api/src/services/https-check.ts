import { isIP } from "node:net";
import { type ConnectionOptions, connect, type TLSSocket } from "node:tls";
import { domainName } from "./spec";

export interface HttpsCheck {
  verified: boolean;
  reachable: boolean;
  status: "verified" | "http_error" | "unavailable" | "no_dns" | "blocked";
  httpStatus?: number;
  checkedAt: number;
}

// Accept only public unicast destinations, including rejecting IPv4-mapped IPv6,
// translation/transition ranges and documentation networks. No DNS lookup occurs
// after this check: the TLS socket connects to this literal IP, with hostname SNI.
export function publicProbeAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) !== 6) return false;
  const normalized = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  if (!/^[23][0-9a-f]{3}:/i.test(normalized)) return false;
  const [first, second = "0"] = normalized.split(":");
  return !(
    first === "2002" ||
    first === "3fff" ||
    (first === "2001" && (parseInt(second, 16) < 0x200 || second === "db8"))
  );
}

type Connector = (options: ConnectionOptions) => TLSSocket;
// HEAD / only; no cookies, credentials, bodies, redirects, custom ports or paths.
// A hard deadline and header cap bound resource use even for hostile endpoints.
export function probeHttps(
  hostname: string,
  address: string,
  connector: Connector = (options) => connect(options),
): Promise<HttpsCheck> {
  const result = (
    status: HttpsCheck["status"],
    verified = false,
    httpStatus?: number,
  ): HttpsCheck => ({
    status,
    verified,
    reachable: status === "verified",
    checkedAt: Date.now(),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
  if (!publicProbeAddress(address)) return Promise.resolve(result("blocked"));
  try {
    if (domainName(hostname) !== hostname)
      return Promise.resolve(result("blocked"));
  } catch {
    return Promise.resolve(result("blocked"));
  }
  return new Promise((resolve) => {
    let socket: TLSSocket | undefined;
    let done = false;
    let verified = false;
    let headers = "";
    const finish = (value: HttpsCheck) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(result("unavailable", verified)),
      5000,
    );
    try {
      socket = connector({
        host: address,
        port: 443,
        servername: hostname,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"],
      });
      socket.once("secureConnect", () => {
        if (!socket?.authorized) return finish(result("unavailable"));
        verified = true;
        socket.write(
          `HEAD / HTTP/1.1\r\nHost: ${hostname}\r\nUser-Agent: Ephor-HTTPS-Check/1\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        headers += chunk.toString("latin1");
        if (headers.length > 16384)
          return finish(result("unavailable", verified));
        if (!headers.includes("\r\n\r\n")) return;
        const match = /^HTTP\/1\.[01] ([2-5][0-9]{2})[ \r]/.exec(headers);
        if (!match) return finish(result("unavailable", verified));
        const status = Number(match[1]);
        // Authentication-protected catalog apps legitimately return 401/403.
        const reachable = status < 400 || status === 401 || status === 403;
        finish(
          result(
            reachable && verified ? "verified" : "http_error",
            verified,
            status,
          ),
        );
      });
      socket.once("error", () => finish(result("unavailable", verified)));
      socket.once("close", () => finish(result("unavailable", verified)));
    } catch {
      finish(result("unavailable", verified));
    }
  });
}

export async function checkHttps(
  hostname: string,
  records: { value: string }[],
  probe = probeHttps,
): Promise<HttpsCheck> {
  const failure = (status: "no_dns" | "blocked"): HttpsCheck => ({
    status,
    verified: false,
    reachable: false,
    checkedAt: Date.now(),
  });
  if (!records.length) return failure("no_dns");
  // Mixed public/private DNS is rejected, rather than probing only the safe subset.
  if (records.some((r) => !publicProbeAddress(r.value)))
    return failure("blocked");
  // Sample one public endpoint, preferring IPv4 for hosts without IPv6 egress.
  const address =
    records.find((r) => isIP(r.value) === 4)?.value ?? records[0]?.value;
  return address ? probe(hostname, address) : failure("no_dns");
}
