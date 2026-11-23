import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { siHetzner } from "simple-icons";
import { ProviderIcon, ProviderLabel } from "../src/components/provider-label";

function icon(name?: string | null, className?: string) {
  return renderToStaticMarkup(createElement(ProviderIcon, { name, className }));
}

test("provider icons recognize exact case-insensitive aliases", () => {
  for (const name of [
    "Hetzner",
    " HETZNER CLOUD ",
    "hetzner-cloud",
    "hetzner_cloud",
  ])
    expect(icon(name)).toContain(siHetzner.path);
});

test("unknown and custom providers use the same fallback without guessing a brand", () => {
  const fallback = icon();
  for (const name of [null, "", "Unknown", "My Hetzner server", "__proto__"])
    expect(icon(name)).toBe(fallback);
});

test("brand, image, and fallback icons accept the heading size", () => {
  for (const name of ["Hetzner", "AWS", "Azure", "Oracle Cloud", "Custom"])
    expect(icon(name, "size-6")).toContain("size-6");
  expect(icon("AWS")).toContain("<img");
  expect(icon("AWS")).toContain('alt=""');
});

test("provider labels retain their names and existing icons", () => {
  const label = renderToStaticMarkup(
    createElement(ProviderLabel, { name: " Hetzner " }),
  );
  expect(label).toContain(siHetzner.path);
  expect(label).toContain(">Hetzner</span>");
  expect(renderToStaticMarkup(createElement(ProviderLabel))).toContain(
    ">Unknown</span>",
  );
});
