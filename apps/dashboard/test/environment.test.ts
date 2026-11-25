import { expect, test } from "bun:test";
import { formatEnvironment, parseEnvironment } from "../src/lib/environment";

test("raw variable editor preserves literal values, quotes, and multiline secrets", () => {
  const values = {
    EMPTY: "",
    URL: "https://host/path?a=b#hash",
    KEY: 'first\nsecond "quoted" \\ slash\tend',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Environment substitutions must stay literal.
    LITERAL: "${OTHER} $(command)",
    SPACE: "  padded  ",
    CONTROL: "\r\t\b\f\u0001",
  };
  expect(parseEnvironment(formatEnvironment(values))).toEqual(values);
  expect(parseEnvironment(JSON.stringify(values))).toEqual(values);
  expect(
    parseEnvironment(
      "# comment\nexport FOO='first\nsecond'\nBAR=hello # note\nTOKEN=abc==",
    ),
  ).toEqual({ FOO: "first\nsecond", BAR: "hello", TOKEN: "abc==" });
});
test("variable input rejects malformed, duplicate, oversized, and non-string values", () => {
  for (const input of [
    "A=1\nA=2",
    'A="unterminated',
    'A="ok" trailing',
    "1INVALID=x",
    '{"A":1}',
    '{"A":null}',
    "{broken",
    `A=${"a".repeat(64 * 1024 + 1)}`,
    "A=\u0000",
    Array.from({ length: 1025 }, (_, i) => `VAR_${i}=x`).join("\n"),
  ])
    expect(() => parseEnvironment(input)).toThrow();
});
test("prototype-like variable names are treated as literal keys", () => {
  const values = parseEnvironment("__proto__=literal\nconstructor=value");
  expect(Object.hasOwn(values, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(values, "__proto__")?.value).toBe(
    "literal",
  );
  expect(parseEnvironment(formatEnvironment(values))).toEqual(values);
});

test("raw editor accepts large environments and reports byte limits precisely", () => {
  const values = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`VAR_${i}`, "x".repeat(512)]),
  );
  values.CERTIFICATE = "é".repeat(32 * 1024);
  expect(parseEnvironment(formatEnvironment(values))).toEqual(values);
  expect(() => parseEnvironment(`CERTIFICATE=${values.CERTIFICATE}é`)).toThrow(
    "64 KiB",
  );
  expect(() =>
    parseEnvironment(
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            `KEY_${i}`,
            "x".repeat(64 * 1024),
          ]),
        ),
      ),
    ),
  ).toThrow("256 KiB");
  expect(() =>
    parseEnvironment(
      Array.from({ length: 1025 }, (_, i) => `KEY_${i}=x`).join("\n"),
    ),
  ).toThrow("1,024");
});

test("environment total and count boundaries match daemon validation", () => {
  const values = {
    A: "x".repeat(64 * 1024),
    B: "x".repeat(64 * 1024),
    C: "x".repeat(64 * 1024),
    D: "x".repeat(64 * 1024 - 29),
  };
  expect(parseEnvironment(JSON.stringify(values))).toEqual(values);
  expect(() =>
    parseEnvironment(JSON.stringify({ ...values, D: `${values.D}x` })),
  ).toThrow("256 KiB");
  const many = Object.fromEntries(
    Array.from({ length: 1024 }, (_, i) => [`VAR_${i}`, "x"]),
  );
  expect(parseEnvironment(formatEnvironment(many))).toEqual(many);
});
