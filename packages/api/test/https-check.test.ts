import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { catalogConfig } from "../src/services/catalog";
import {
  checkHttps,
  probeHttps,
  publicProbeAddress,
} from "../src/services/https-check";
import { imageTechnology } from "../src/services/technology";

test("HTTPS probes reject private, reserved, mapped and transition IP addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "64:ff9b::a00:1",
    "2002:0808:0808::1",
    "2001:db8::1",
    "3fff::1",
    "127.1",
    "example.com",
  ])
    expect(publicProbeAddress(ip)).toBe(false);
  for (const ip of ["2.29.202.199", "8.8.8.8", "2606:4700:4700::1111"])
    expect(publicProbeAddress(ip)).toBe(true);
});

test("mixed public/private DNS never opens a connection", async () => {
  let calls = 0;
  const probe = async () => {
    calls++;
    throw new Error("must not connect");
  };
  expect((await checkHttps("app.example.com", [], probe)).status).toBe(
    "no_dns",
  );
  expect(
    (
      await checkHttps(
        "app.example.com",
        [{ value: "8.8.8.8" }, { value: "::1" }],
        probe,
      )
    ).status,
  ).toBe("blocked");
  expect(calls).toBe(0);
});

function mockProbe(response: string, authorized = true) {
  const socket = new EventEmitter() as TLSSocket;
  let options: ConnectionOptions | undefined;
  let request = "";
  let destroyed = false;
  Object.assign(socket, {
    authorized,
    write: (value: string) => {
      request = value;
      queueMicrotask(() => socket.emit("data", Buffer.from(response)));
      return true;
    },
    destroy: () => {
      destroyed = true;
      return socket;
    },
  });
  const result = probeHttps("app.example.com", "8.8.8.8", (value) => {
    options = value;
    queueMicrotask(() => socket.emit("secureConnect"));
    return socket;
  });
  return { result, inspect: () => ({ options, request, destroyed }) };
}

test("probe pins destination IP, validates hostname TLS and sends only an unauthenticated HEAD", async () => {
  const p = mockProbe("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  expect(await p.result).toMatchObject({
    verified: true,
    reachable: true,
    httpStatus: 200,
  });
  expect(p.inspect().options).toMatchObject({
    host: "8.8.8.8",
    port: 443,
    servername: "app.example.com",
    rejectUnauthorized: true,
  });
  expect(p.inspect().request).toStartWith(
    "HEAD / HTTP/1.1\r\nHost: app.example.com\r\n",
  );
  expect(p.inspect().request).not.toContain("Authorization");
  expect(p.inspect().destroyed).toBe(true);
});

test("invalid certificate cannot produce HTTPS success", async () => {
  const p = mockProbe("HTTP/1.1 200 OK\r\n\r\n", false);
  expect(await p.result).toMatchObject({ verified: false, reachable: false });
  expect(p.inspect().request).toBe("");
});

test("protected apps and redirects verify, but gateway errors remain visible", async () => {
  for (const status of [200, 302, 401, 403]) {
    const p = mockProbe(
      `HTTP/1.1 ${status} Status\r\nLocation: http://127.0.0.1/\r\n\r\n`,
    );
    expect(await p.result).toMatchObject({
      status: "verified",
      httpStatus: status,
    });
    expect(p.inspect().request.match(/HEAD/g)?.length).toBe(1);
  }
  expect(
    await mockProbe("HTTP/1.1 502 Bad Gateway\r\n\r\n").result,
  ).toMatchObject({
    verified: true,
    reachable: false,
    status: "http_error",
    httpStatus: 502,
  });
});

test("malformed and oversized responses do not report success", async () => {
  expect((await mockProbe("not HTTP\r\n\r\n").result).reachable).toBe(false);
  expect(
    (
      await mockProbe(`HTTP/1.1 200 OK\r\nX: ${"a".repeat(17000)}\r\n\r\n`)
        .result
    ).reachable,
  ).toBe(false);
});

test("Uptime Kuma resolves a branded technology for existing images and new catalog services", () => {
  const config = catalogConfig("uptime-kuma");
  expect(config.source.technology).toBe("uptimekuma");
  expect(imageTechnology(config.config.image)).toBe("uptimekuma");
});
