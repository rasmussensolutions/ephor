export type LogTone =
  | "default"
  | "heading"
  | "error"
  | "warning"
  | "success"
  | "info";

export function formatLogLines(output: string) {
  let offset = 0;
  let errorSection = false;
  return output.split(/(?<=\n)/).map((text) => {
    const key = offset;
    offset += text.length;
    const heading = /^── .+ ──\s*$/.test(text);
    if (heading) errorSection = text.trim() === "── Error ──";
    // Ignore zero-count summaries when looking for severity words.
    const message = text.replace(
      /\b(?:0|no)\s+(?:errors?|warnings?|failures?)\b/gi,
      "",
    );
    const tone: LogTone = errorSection
      ? "error"
      : heading
        ? "heading"
        : /\b(?:error|fatal|panic|exception|failed|failure)\b|\bERR!|^\s*[✗✘×]/i.test(
              message,
            )
          ? "error"
          : /\b(?:warn(?:ing)?|deprecated|deprecation)\b|^\s*⚠/i.test(message)
            ? "warning"
            : /\b(?:success(?:ful(?:ly)?)?|succeeded|completed|ready|listening)\b|\bcompiled successfully\b|^\s*[✓✔]/i.test(
                  message,
                )
              ? "success"
              : /\b(?:info|debug|trace)\b/i.test(message)
                ? "info"
                : "default";
    return { key, text, tone };
  });
}
