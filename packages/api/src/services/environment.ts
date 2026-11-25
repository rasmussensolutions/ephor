// Shared by the browser and API. Keep the daemon's validator in sync.
export const MAX_ENVIRONMENT_VARIABLES = 1024;
export const MAX_ENVIRONMENT_BYTES = 256 * 1024;
export const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
// Allows runtime + build variables together, plus request metadata.
export const ENVIRONMENT_REQUEST_BYTES = 1024 * 1024;

export const environmentMessages = {
  ENVIRONMENT_TOO_MANY_VARIABLES: "Use up to 1,024 environment variables.",
  ENVIRONMENT_TOO_LARGE:
    "Environment variables exceed 256 KiB in total, including names and JSON formatting.",
  ENVIRONMENT_VALUE_TOO_LARGE:
    "Each environment value can contain up to 64 KiB of UTF-8 text.",
  INVALID_ENVIRONMENT:
    "Use string values without null bytes and variable names of up to 64 letters, numbers, or underscores, starting with a letter or underscore.",
} as const;

export function environmentError(
  values: unknown,
): keyof typeof environmentMessages | null {
  if (!values || typeof values !== "object" || Array.isArray(values))
    return "INVALID_ENVIRONMENT";
  const entries = Object.entries(values);
  if (entries.length > MAX_ENVIRONMENT_VARIABLES)
    return "ENVIRONMENT_TOO_MANY_VARIABLES";
  const encoder = new TextEncoder();
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ||
      typeof value !== "string" ||
      value.includes("\0")
    )
      return "INVALID_ENVIRONMENT";
    if (encoder.encode(value).byteLength > MAX_ENVIRONMENT_VALUE_BYTES)
      return "ENVIRONMENT_VALUE_TOO_LARGE";
  }
  if (encoder.encode(JSON.stringify(values)).byteLength > MAX_ENVIRONMENT_BYTES)
    return "ENVIRONMENT_TOO_LARGE";
  return null;
}
