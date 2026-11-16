import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const shellToken =
  /(?<quoted>'[^']*'|"(?:\\.|[^"\\])*")|(?<variable>\$\w+)|(?<flag>--?[a-z][\w-]*)|(?<keyword>\b(?:if|then|else|fi)\b)|(?<command>\b(?:set|trap|curl|mktemp|id|printf|sh|sudo|rm)\b)|(?<operator>[;|=])/g;

const tokenColors = {
  quoted: "text-emerald-800 dark:text-emerald-300",
  variable: "text-violet-700 dark:text-violet-300",
  flag: "text-amber-800 dark:text-amber-300",
  keyword: "text-violet-700 dark:text-violet-300",
  command: "text-blue-700 dark:text-blue-300",
  operator: "text-neutral-500 dark:text-neutral-400",
};

export function EnrollmentCommand({ command }: { command: string }) {
  const parts: ReactNode[] = [];
  let offset = 0;

  for (const match of command.matchAll(shellToken)) {
    const [token] = match;
    const color = Object.entries(tokenColors).find(
      ([kind]) => match.groups?.[kind] !== undefined,
    )?.[1];

    parts.push(command.slice(offset, match.index));
    parts.push(
      <span key={match.index} className={color}>
        {token}
      </span>,
    );
    offset = match.index + token.length;
  }
  parts.push(command.slice(offset));

  return (
    <pre className="max-w-full overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 font-mono text-[0.8125rem] leading-6 wrap-anywhere whitespace-pre-wrap select-all dark:border-neutral-800 dark:bg-neutral-950">
      <code>{parts}</code>
    </pre>
  );
}

export function CopyEnrollmentCommand({
  command,
  onCopyError,
}: {
  command: string;
  onCopyError: (message: string) => void;
}) {
  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  useEffect(() => {
    if (copiedAt === null) return;
    const timeout = setTimeout(() => setCopiedAt(null), 3000);
    return () => clearTimeout(timeout);
  }, [copiedAt]);

  return (
    <>
      <Button
        variant="raised"
        size="action"
        className="min-w-0 leading-tight whitespace-normal"
        alternateContent={{
          active: copiedAt !== null,
          children: (
            <>
              <CheckIcon aria-hidden="true" data-icon="inline-start" />
              Copied
            </>
          ),
        }}
        onClick={async () => {
          onCopyError("");
          try {
            await navigator.clipboard.writeText(command);
            setCopiedAt(Date.now());
          } catch {
            setCopiedAt(null);
            onCopyError("Copy failed. Select and copy the command manually.");
          }
        }}
      >
        <CopyIcon aria-hidden="true" data-icon="inline-start" />
        Copy command
      </Button>
      <span role="status" className="sr-only">
        {copiedAt !== null ? "Command copied." : ""}
      </span>
    </>
  );
}
