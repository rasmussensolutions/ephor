export function validateEnvironment(values: unknown): Record<string, string> {
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error(
      "Use a JSON object with string values, or NAME=value lines.",
    );
  const entries = Object.entries(values);
  if (entries.length > 64 || JSON.stringify(values).length > 12000)
    throw new Error("Use up to 64 variables and 12 KB in total.");
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
      throw new Error(
        "Variable names must start with a letter or underscore and contain only letters, numbers, and underscores (up to 64 characters).",
      );
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      value.length > 4096
    )
      throw new Error(
        "Values must be strings of up to 4,096 characters without null bytes.",
      );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Literal .env values only: never evaluate substitutions or expand variables. */
export function parseEnvironment(text: string) {
  if (text.trimStart().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        "The JSON is invalid. Use an object with quoted names and string values.",
      );
    }
    return validateEnvironment(parsed);
  }
  const values: Record<string, string> = Object.create(null);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    const name = match?.[1];
    if (!match || !name) throw new Error(`Line ${i + 1}: use NAME=value.`);
    if (Object.hasOwn(values, name))
      throw new Error(`Duplicate variable: ${name}`);
    let value = match[2] ?? "";
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      let end = -1;
      for (let at = 1; ; at++) {
        if (at >= value.length) {
          if (++i >= lines.length)
            throw new Error(`Unclosed quoted value for ${name}.`);
          value += `\n${lines[i]}`;
        }
        if (value[at] === quote) {
          end = at;
          break;
        }
        if (quote === '"' && value[at] === "\\") at++;
      }
      if (
        value.slice(end + 1).trim() &&
        !value
          .slice(end + 1)
          .trimStart()
          .startsWith("#")
      )
        throw new Error(`Unexpected text after the quoted value for ${name}.`);
      const literal = value.slice(1, end);
      const quoted = value.slice(0, end + 1);
      value =
        quote === "'"
          ? literal
          : literal.replace(
              /\\([\\"nrt])/g,
              (_, escaped: string) =>
                ({ n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' })[
                  escaped
                ] ?? escaped,
            );
      if (quote === '"') {
        try {
          value = JSON.parse(quoted) as string;
        } catch {
          /* .env also allows literal multiline values and unknown escapes. */
        }
      }
    } else value = value.replace(/\s+#.*$/, "").trim();
    values[name] = value;
  }
  return validateEnvironment(values);
}

export function formatEnvironment(values: Record<string, string>) {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n");
}
