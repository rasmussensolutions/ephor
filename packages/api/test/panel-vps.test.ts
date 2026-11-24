import { expect, test } from "bun:test";
import { compose, panelOrigin, proxyCompose } from "../../../scripts/panel-vps";

test("VPS domain input cannot introduce proxy directives or change the origin scheme", () => {
  expect(panelOrigin("panel.example.com")).toBe("https://panel.example.com");
  expect(panelOrigin("https://panel.example.com/")).toBe(
    "https://panel.example.com",
  );
  for (const value of [
    "http://panel.example.com",
    "https://user@panel.example.com",
    "https://panel.example.com:8443",
    "panel.example.com/path",
    "panel.example.com?x=1",
    "panel.example.com#x",
    "127.0.0.1",
    "panel.example.com { respond hacked }",
  ]) {
    expect(() => panelOrigin(value)).toThrow();
  }
});
test("host configuration rejects foreign images and injected volume names", () => {
  const image = `ghcr.io/rasmussensolutions/ephor-panel@sha256:${"a".repeat(64)}`;
  expect(() => compose(image, "existing_db")).not.toThrow();
  expect(() => compose("attacker/panel:latest")).toThrow();
  expect(() => compose(image, "db\n  malicious: true")).toThrow();
  expect(() => proxyCompose("caddy:latest")).toThrow();
});
