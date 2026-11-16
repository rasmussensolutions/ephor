import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/auth";
import { primaryAddress } from "@/lib/machine-address";
import type { Service } from "@/lib/services";

type DnsResult = {
  domains: {
    hostname: string;
    records: { type: string; value: string }[];
    matches: boolean;
    https: {
      verified: boolean;
      reachable: boolean;
      status: "verified" | "http_error" | "unavailable" | "no_dns" | "blocked";
      httpStatus?: number;
    };
  }[];
};

export function ServiceDomains({
  service,
  addresses,
  visible,
  showNotice,
  running,
  onOpen,
  onConfigure,
}: {
  service: Service;
  addresses: string[];
  visible: boolean;
  showNotice: boolean;
  running: boolean;
  onOpen: () => void;
  onConfigure?: () => void;
}) {
  const [dns, setDns] = useState<DnsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const checking = useRef(false);
  const mounted = useRef(true);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const hosts = [service.domain, ...(service.domains?.aliases ?? [])].filter(
    (host): host is string => !!host,
  );
  const address = primaryAddress(addresses);
  const complete =
    hosts.length > 0 &&
    hosts.every((host) => {
      const domain = dns?.domains.find((d) => d.hostname === host);
      return domain?.matches && domain.https.reachable;
    });
  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<DnsResult>(`/services/${service.id}/dns`);
      if (mounted.current) {
        setDns(result);
        setCheckedAt(Date.now());
      }
    } catch (e) {
      if (mounted.current) {
        setDns(null);
        setError(e instanceof Error ? e.message : "Domain check failed.");
      }
    } finally {
      checking.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [service.id]);
  useEffect(() => {
    mounted.current = true;
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, 60_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [check]);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setError("Could not copy. Select and copy the value below.");
    }
  }
  if (!visible)
    return showNotice && service.domain && !complete ? (
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5">
        <div>
          <h2 className="font-medium">Connect your domain</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {running ? "Your app is running. " : ""}Set up DNS and verify HTTPS
            to make it reachable at {service.domain}.
          </p>
        </div>
        <Button variant="outline" onClick={onOpen}>
          Set up domain
        </Button>
      </section>
    ) : null;
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">Domains & HTTPS</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect your domain or subdomain to this machine.
          </p>
        </div>
        <div className="flex gap-2">
          {onConfigure && (
            <Button variant="outline" onClick={onConfigure}>
              Edit domains
            </Button>
          )}
          {hosts.length > 0 && (
            <Button variant="outline" disabled={busy} onClick={check}>
              {busy ? "Checking…" : "Check DNS & HTTPS"}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {copied && (
        <p role="status" className="text-xs text-muted-foreground">
          Copied {copied}
        </p>
      )}
      {hosts.length === 0 ? (
        <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
          No public domain configured.{" "}
          {onConfigure
            ? "Add one using Edit domains, then deploy the updated configuration."
            : "This app is available on its private container network."}
        </p>
      ) : (
        <>
          <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
            <p>
              Add the record below at your DNS provider. Use the full hostname
              if supported, or @ for the root of your DNS zone and the relative
              name for a subdomain. Leave TTL on Auto.
            </p>
            <p className="mt-2">
              Allow inbound TCP 80 and 443 on the VPS. Start with DNS-only
              (proxy disabled). Remove conflicting A or AAAA records; add AAAA
              only if IPv6 is configured and reaches this machine.
            </p>
          </div>
          {hosts.map((host) => {
            const result = dns?.domains.find((d) => d.hostname === host);
            return (
              <article
                key={host}
                className="space-y-5 rounded-xl border bg-card p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-medium break-all">{host}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {host === service.domain
                        ? "Primary domain"
                        : service.domains?.redirect
                          ? `Redirects to ${service.domain}`
                          : "Alias"}
                    </p>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {result?.matches
                      ? "DNS matches"
                      : result
                        ? result.records.length
                          ? "DNS differs from this machine"
                          : "Waiting for DNS"
                        : "DNS not checked"}
                  </span>
                </div>
                <Table className="[&_td]:p-3 [&_th]:h-auto [&_th]:p-3">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Name / hostname</TableHead>
                      <TableHead>Value / target</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow className="hover:bg-transparent">
                      <TableCell>
                        {address?.includes(":") ? "AAAA" : "A"}
                      </TableCell>
                      <TableCell>
                        <CopyValue value={host} onCopy={copy} />
                      </TableCell>
                      <TableCell>
                        {address ? (
                          <CopyValue value={address} onCopy={copy} />
                        ) : (
                          "Public IP not reported by this machine yet."
                        )}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                {result && (
                  <p className="text-xs text-muted-foreground break-all">
                    Detected records:{" "}
                    {result.records
                      .map((r) => `${r.type} ${r.value}`)
                      .join(" · ") || "None"}
                    .{" "}
                    {result.matches
                      ? "All returned addresses match this machine."
                      : "DNS changes may take time to propagate. A DNS proxy can hide the machine’s IP."}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
                  <div className="max-w-xl">
                    <h4 className="text-sm font-medium">
                      HTTPS ·{" "}
                      {result?.https.reachable
                        ? "Verified"
                        : result?.https.verified
                          ? "Certificate valid · check response"
                          : busy
                            ? "Checking…"
                            : "Not verified"}
                    </h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {result?.https.reachable
                        ? `Valid certificate and HTTPS response (HTTP ${result.https.httpStatus}). Redirects are not followed; this checks the public endpoint, not application health.`
                        : result?.https.status === "http_error"
                          ? `The certificate is valid, but the site returned HTTP ${result.https.httpStatus}. Check the app and proxy logs.`
                          : result?.https.status === "blocked"
                            ? "DNS includes a private or reserved address. Ephor only checks public endpoints."
                            : result?.https.status === "no_dns"
                              ? "Waiting for DNS. HTTPS will be checked automatically once the domain resolves."
                              : "Could not verify HTTPS yet. Certificates are provisioned automatically after deployment. Check DNS and allow TCP 80/443. Ephor retries every minute while this page is open."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      className="rounded-lg border px-3 py-2 text-sm hover:bg-accent"
                      href={`https://${host}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open HTTPS ↗
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
          {checkedAt && (
            <p className="text-xs text-muted-foreground">
              Last checked at {new Date(checkedAt).toLocaleTimeString()}. DNS
              and HTTPS are checked automatically every minute while this page
              is visible.
            </p>
          )}
        </>
      )}
    </section>
  );
}
function CopyValue({
  value,
  onCopy,
}: {
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <code className="break-all">{value}</code>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Copy ${value}`}
        onClick={() => onCopy(value)}
      >
        Copy
      </Button>
    </div>
  );
}
