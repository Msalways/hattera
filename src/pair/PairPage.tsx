import { useEffect, useRef, useState } from "react";
import { Github, Server } from "lucide-react";
import { DesktopWorkspaceSwitcher } from "../components/DesktopWorkspaceSwitcher";

import {
  defaultDeviceLabel,
  isConnected,
  newAttemptId,
  pairWithCode,
  readSessionState,
  reasonWorthShowing,
  startEmailSignIn,
  verifyEmailSignIn,
  type EnvironmentDescriptor,
  type SessionState,
} from "../lib/session";
import { pairedDestination } from "../lib/phone-pairing";
import { brand } from "../lib/brand";

const input = "mt-1 w-full rounded-md border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink outline-none focus:border-accent-border";
const button = "mt-5 w-full rounded-md bg-accent px-4 py-2 text-[14px] font-medium text-accent-ink disabled:opacity-50";
const fieldLabel = "mt-4 block text-[12px] font-medium text-ink-secondary";

export function githubSignInTarget(currentOrigin: string, configuredOrigin?: string): string | null {
  return configuredOrigin && configuredOrigin !== currentOrigin ? `${configuredOrigin}/pair?githubStart=1` : null;
}

/** Desktop links and server-confirmed local CLI links redeem their one-use
 * code automatically. Self-hosted and ordinary remote links ask for confirmation. The
 * marker never grants access: the server must validate the code and session. */
export function pairsAutomatically(
  initialCode: string | null,
  desktop = typeof window !== "undefined" && Boolean(window.ogb?.workspaces),
  search = typeof location !== "undefined" ? location.search : "",
  hostname = typeof location !== "undefined" ? location.hostname : "",
  localCli = false,
): boolean {
  return Boolean(initialCode) && (desktop || localCli && new URLSearchParams(search).get("cli") === "1"
    && ["localhost", "127.0.0.1", "[::1]"].includes(hostname));
}

/** What the page says above the form. My Cloud has no server screen to
 * read a code from: it says where its connection starts instead. */
export function pairIntro({ mode, sent, email, cloudHome }: { mode: "email" | "code" | null; sent: boolean; email: string; cloudHome: boolean }): string {
  if (mode === "email") return sent ? `We emailed an 8-digit code to ${email}. It works once and expires in ten minutes.` : "Enter your email and we will send you a one-time code.";
  if (cloudHome) return "To open My Cloud, choose Open My Cloud in the desktop app (Settings → Hattera Cloud), or Use in your browser on your Plan page. Have a pairing code? Enter it below.";
  return "Enter the pairing code shown on the server. Codes work once and expire after five minutes.";
}

/** The page a pairing link opens: /pair#code=XXXX-XXXX-XXXX. Also what the
 * app shows instead of itself when a remote browser has no session yet.
 * When the server has a sign-in allow-list, "sign in with your email" comes
 * first and the pairing code stays one link away. */
export function PairPage({ initialCode, initialEmail = null, reason }: { initialCode: string | null; initialEmail?: string | null; reason?: string }) {
  const [code, setCode] = useState(initialCode ?? "");
  const [label, setLabel] = useState(defaultDeviceLabel());
  const [environment, setEnvironment] = useState<EnvironmentDescriptor | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one id per code typed: a retry after a lost response reuses it, a new code gets a new one
  const [attemptId, setAttemptId] = useState(() => newAttemptId());
  const [mode, setMode] = useState<"email" | "code" | null>(initialCode ? "code" : null);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [opening, setOpening] = useState(() => pairsAutomatically(initialCode));
  const githubAutoStart = useRef(false);

  useEffect(() => {
    if (!initialCode || !pairsAutomatically(initialCode, undefined, undefined, undefined, environment?.capabilities.localCli === true)) return;
    setOpening(true);
    let active = true;
    void pairWithCode({ code: initialCode, label, attemptId }).then((result) => {
      if (!active) return;
      if (result.ok) { location.replace(pairedDestination(location.search)); return; }
      setOpening(false);
      setError(result.error);
    });
    return () => { active = false; };
    // Once, for the code the link carried.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment?.capabilities.localCli]);

  useEffect(() => {
    void fetch("/.well-known/openmausbot/environment")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EnvironmentDescriptor | null) => {
        setEnvironment(d);
        setMode((current) => current ?? (d?.capabilities.emailSignIn ? "email" : "code"));
      })
      .catch(() => {
        setEnvironment(null);
        setMode((current) => current ?? "code");
      });
    void readSessionState().then(setSession);
  }, []);

  const connected = isConnected(session);
  const emailOffered = environment?.capabilities.emailSignIn === true;
  const cloudHome = environment?.capabilities.cloudHome === true;
  const githubFailure = new URLSearchParams(location.search).get("github");

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await pairWithCode({ code, label, attemptId });
    setBusy(false);
    if (result.ok) {
      location.replace(pairedDestination(location.search));
      return;
    }
    setError(result.error);
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = sent ? await verifyEmailSignIn({ email, code: otp, label }) : await startEmailSignIn(email);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (sent) {
      location.replace(pairedDestination(location.search));
      return;
    }
    setSent(true);
  }

  function submitGithub() {
    setBusy(true);
    setError(null);
    location.assign(githubSignInTarget(location.origin, environment?.githubSignInOrigin) ?? "/identity/start/github");
  }

  useEffect(() => {
    if (!environment?.githubSignInOrigin || !new URLSearchParams(location.search).has("githubStart") || githubAutoStart.current) return;
    githubAutoStart.current = true;
    history.replaceState(null, "", "/pair");
    submitGithub();
    // The configured origin arrives once from the public server descriptor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment?.githubSignInOrigin]);

  function switchMode(next: "email" | "code") {
    setMode(next);
    setError(null);
  }

  return (
    <main className="hattera-pair min-h-screen bg-app text-ink">
      <aside className="hattera-pair-hero">
        <div className="hattera-pair-logo"><img src={brand().logo ?? "/hattera-mark.svg"} alt="" /><span>{brand().name}</span></div>
        <DesktopWorkspaceSwitcher />
      </aside>
      <section className="hattera-pair-main">
      <div className="hattera-pair-content">
        {opening ? (
          <p role="status" className="text-[20px] font-semibold">{cloudHome ? "Opening My Cloud…" : `Connecting to ${environment?.label ?? "this Hattera server"}…`}</p>
        ) : <>
        <h1 className="hattera-pair-title">{cloudHome ? "My Cloud" : `Connect to your ${brand().name} server`}</h1>
        {environment?.label && !cloudHome ? <div className="hattera-pair-server"><Server size={17} aria-hidden="true" /><span>{environment.label}</span></div> : null}
        <p className="hattera-pair-intro text-ink-secondary">{cloudHome || mode === "email" ? pairIntro({ mode, sent, email, cloudHome }) : environment?.capabilities.githubSignIn ? "Sign in with GitHub or use a pairing code to connect this device to your server." : pairIntro({ mode, sent, email, cloudHome })}</p>
        {reasonWorthShowing(reason) && !connected ? <p className="mt-3 text-[13px] text-ink-secondary">{reasonWorthShowing(reason)}</p> : null}
        {githubFailure && !connected ? <p role="alert" className="mt-3 text-[13px] text-danger">{githubFailure === "state" ? "GitHub sign-in lost its browser session. Start again from this page." : githubFailure === "start" ? "GitHub sign-in could not start. Try again or check the server log." : "GitHub sign-in did not finish. Use the configured owner account and try again."}</p> : null}
        {/* An expired or used code on a Cloud: the app starts a fresh one. */}
        {error && cloudHome && initialCode ? <p className="mt-3 text-[13px] text-ink-secondary">This link has expired or was already used. In the desktop app, open Settings → Hattera Cloud and choose Open My Cloud.</p> : null}
        </>}
        <div className="hattera-pair-options">
        {!opening && !connected && environment?.capabilities.githubSignIn ? (
          <div className="hattera-pair-card hattera-pair-github">
            <button type="button" onClick={submitGithub} disabled={busy} className={button}><Github size={20} aria-hidden="true" />Sign in with GitHub</button>
          </div>
        ) : null}
        {!opening && !connected && environment?.capabilities.githubSignIn ? <div className="hattera-pair-divider" aria-hidden="true"><span>or</span></div> : null}
        {opening ? null : connected ? (
          <p className="mt-4 text-[13.5px]">
            This browser is already connected.{" "}
            <a href="/" className="text-accent underline">
              Open the app
            </a>
          </p>
        ) : mode === "email" ? (
          <form onSubmit={submitEmail} className="hattera-pair-card">
            <h2 className="sr-only">Sign in with email</h2>
            <label className={fieldLabel} htmlFor="signin-email">
              Email
            </label>
            <input
              id="signin-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSent(false);
                setOtp("");
              }}
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              className={input}
            />
            {sent ? (
              <>
                <label className={fieldLabel} htmlFor="signin-code">
                  Code from the email
                </label>
                <input
                  id="signin-code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="12345678"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  spellCheck={false}
                  className={`${input} font-mono text-[15px] tracking-[0.12em]`}
                />
                <label className={fieldLabel} htmlFor="signin-label">
                  This device
                </label>
                <input id="signin-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className={input} />
              </>
            ) : null}
            {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
            <button type="submit" disabled={busy || !email.includes("@") || (sent && otp.replace(/\D/g, "").length < 8)} className={button}>
              {busy ? (sent ? "Signing in…" : "Sending…") : sent ? "Sign in" : "Send code"}
            </button>
            {sent ? (
              <button type="button" onClick={() => setSent(false)} className="mt-3 w-full text-[13px] text-ink-secondary underline">
                Send a new code
              </button>
            ) : null}
            <button type="button" onClick={() => switchMode("code")} className="mt-3 w-full text-[13px] text-ink-secondary underline">
              Have a pairing code instead?
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="hattera-pair-card">
            <h2 className="sr-only">Connect with a pairing code</h2>
            <label className={fieldLabel} htmlFor="pair-code">
              Pairing code
            </label>
            <input
              id="pair-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setAttemptId(newAttemptId());
              }}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              className={`${input} font-mono text-[15px] tracking-[0.12em]`}
            />
            <p className="hattera-pair-hint text-ink-secondary">Codes work once and expire after five minutes.</p>
            <label className={fieldLabel} htmlFor="pair-label">
              This device
            </label>
            <input id="pair-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className={input} />
            {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
            <button type="submit" disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 12} className={button}>
              {busy ? "Connecting…" : "Connect"}
            </button>
            {emailOffered ? (
              <button type="button" onClick={() => switchMode("email")} className="mt-3 w-full text-[13px] text-ink-secondary underline">
                Sign in with your email instead
              </button>
            ) : null}
          </form>
        )}
        </div>
      </div>
      </section>
    </main>
  );
}
