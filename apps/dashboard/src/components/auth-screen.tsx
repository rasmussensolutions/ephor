import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPasskey, api, signIn } from "@/lib/auth";

const authLinkClassName =
  "inline-block rounded-sm py-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export function AuthScreen({ mode }: { mode: "login" | "setup" | "recover" }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [keyName, setKeyName] = useState("My passkey");
  const [enrolling, setEnrolling] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ configured: boolean; enrolling: boolean }>("/setup/status")
      .then((status) => {
        if (!active) return;
        if (mode === "login" && !status.configured) {
          location.replace("/setup");
          return;
        }
        if (mode === "setup" && status.configured && !status.enrolling) {
          location.replace("/login");
          return;
        }
        setEnrolling(mode !== "login" && status.enrolling);
        setReady(true);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [mode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!window.isSecureContext || !window.PublicKeyCredential)
        throw new Error(
          "Passkeys require HTTPS and a browser with WebAuthn support. Local development can use localhost.",
        );
      if (mode === "login") {
        await signIn();
        location.assign("/");
      } else if (enrolling) {
        await addPasskey(keyName.trim(), true);
        location.assign("/settings/security");
      } else {
        await api(`/${mode === "setup" ? "setup" : "recovery"}/start`, {
          code,
          name: name || "Owner",
        });
        setCode("");
        setEnrolling(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const title =
    mode === "login"
      ? "Welcome back"
      : mode === "setup"
        ? "Set up your workspace"
        : "Recover your account";
  return (
    <main
      id="main"
      className="flex min-h-svh items-center justify-center bg-background px-5 py-8 sm:py-12"
    >
      <section
        aria-labelledby="auth-title"
        className="w-full max-w-md rounded-xl ring-1 ring-border"
      >
        <header className="flex items-center gap-2 px-5 py-3.5 sm:px-7">
          <img
            src="/logo.png"
            alt=""
            width={22}
            height={22}
            className="size-5.5 max-w-none shrink-0 object-contain dark:invert"
          />
          <span className="truncate text-xl font-medium tracking-tight">
            Ephor
          </span>
        </header>
        <div className="space-y-6 rounded-xl bg-card p-5 text-card-foreground ring-1 ring-border sm:p-7">
          <div className="space-y-2">
            <h1
              id="auth-title"
              className="text-2xl font-semibold tracking-tight"
            >
              {title}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {mode === "login"
                ? "Use a passkey to access your infrastructure."
                : enrolling
                  ? "Create a passkey using your device or security key. Your device will ask you to verify your identity."
                  : mode === "setup"
                    ? "Enter the setup code you saved when deploying Ephor, or the code provided by your administrator."
                    : "Enter a saved recovery code. This immediately signs out all sessions and revokes all existing passkeys. You’ll then register a replacement."}
            </p>
          </div>
          <form onSubmit={submit} className="space-y-5">
            {mode !== "login" && !enrolling && (
              <>
                {mode === "setup" && (
                  <div className="grid gap-2">
                    <label htmlFor="owner-name" className="text-sm font-medium">
                      Your name
                    </label>
                    <Input
                      id="owner-name"
                      className="h-10"
                      autoComplete="name"
                      maxLength={80}
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                )}
                <div className="grid gap-2">
                  <label htmlFor="code" className="text-sm font-medium">
                    {mode === "setup" ? "Setup code" : "Recovery code"}
                  </label>
                  <Input
                    id="code"
                    className="h-10"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={128}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
              </>
            )}
            {enrolling && (
              <div className="grid gap-2">
                <label htmlFor="key-name" className="text-sm font-medium">
                  Passkey name
                </label>
                <Input
                  id="key-name"
                  className="h-10"
                  maxLength={80}
                  required
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="grid justify-items-center gap-2">
              <Button
                type="submit"
                variant="gradient"
                size="action"
                className="h-11 w-full"
                disabled={!ready || busy}
              >
                {busy
                  ? "Please wait…"
                  : mode === "login"
                    ? "Sign in with a passkey"
                    : enrolling
                      ? "Create passkey"
                      : "Continue"}
              </Button>
              {mode === "login" && (
                <Link className={authLinkClassName} to="/recover">
                  Lost access to your passkeys?
                </Link>
              )}
            </div>
          </form>
        </div>
        {mode !== "login" && (
          <footer className="px-5 py-3.5 text-center sm:px-7">
            <Link className={authLinkClassName} to="/login">
              Back to sign in
            </Link>
          </footer>
        )}
      </section>
    </main>
  );
}
