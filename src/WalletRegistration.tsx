import { useEffect, useId, useRef, useState } from "react";
import { browserDeployment } from "./lib/browser-deployment";
import {
  canonicalWalletInput,
  currentWalletRegistration,
  prepareWalletRegistration,
  type RegisteredWalletClaim,
  type WalletAuthorization,
  type WalletRegistrationIdentity,
  type WalletRegistrationSession,
} from "./lib/wallet-registration";
import { isWalletChain, type WalletChain } from "./lib/wallets";
import { formatDateTime } from "./Presentation";

const PENDING_WALLET = "slop-wallet-authorization";
const WALLET_ADDRESS = "slop-wallet-address";
function pendingAuthorization(): WalletAuthorization | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_WALLET) ?? "null");
    if (value && Date.parse(value.expiresAt) > Date.now()) return value;
    sessionStorage.removeItem(PENDING_WALLET);
  } catch {
    /* Storage may be disabled; ordinary popup sign-in still works. */
  }
  return undefined;
}
function savedAddress(): string {
  try {
    return sessionStorage.getItem(WALLET_ADDRESS) ?? "";
  } catch {
    return "";
  }
}
function saveAuthorization(value: WalletAuthorization | null) {
  try {
    if (value) sessionStorage.setItem(PENDING_WALLET, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_WALLET);
  } catch {
    /* Same-tab recovery requires tab storage; never persist a token elsewhere. */
  }
}

function CurrentWalletRegistration({
  owner,
  chain,
  chainLabel,
}: {
  owner: WalletRegistrationIdentity;
  chain: WalletChain;
  chainLabel: string;
}) {
  const headingId = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; claim: RegisteredWalletClaim | null }
  >({ status: "loading" });
  const { githubActorId, githubLogin } = owner;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new attempt explicitly retries this read.
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void currentWalletRegistration(
      { githubActorId, githubLogin },
      chain,
      controller.signal,
    )
      .then((claim) => {
        if (!controller.signal.aborted) setState({ status: "ready", claim });
      })
      .catch(() => {
        // An unavailable or invalid receipt is never an empty registration.
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [githubActorId, githubLogin, chain, attempt]);
  return (
    <section aria-labelledby={headingId} className="wallet-confirmation">
      <h3 id={headingId} className="wallet-heading">
        Current {chainLabel} registration
      </h3>
      {state.status === "loading" ? (
        <p role="status">Loading current registration…</p>
      ) : state.status === "error" ? (
        <div role="alert">
          <p>Current registration could not be verified. Please retry.</p>
          <button
            className="button"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry current registration
          </button>
        </div>
      ) : state.claim ? (
        <>
          <dl>
            <div>
              <dt>Registered receiving address</dt>
              <dd>
                <code className="wallet-address">{state.claim.address}</code>
              </dd>
            </div>
            <div>
              <dt>Record observed</dt>
              <dd>
                <time dateTime={state.claim.observedAt}>
                  {formatDateTime(state.claim.observedAt)}
                </time>
              </dd>
            </div>
          </dl>
          <a
            href={`${browserDeployment.api}/api/v1/wallet-claims/${state.claim.claimId}`}
            target="_blank"
            rel="noreferrer"
          >
            View public record
          </a>
        </>
      ) : (
        <p>No {chainLabel} receiving address registered.</p>
      )}
    </section>
  );
}

/** Account Wallets section; /wallet is a compatibility route to it. */
export function WalletRegistration({
  owner = null,
}: {
  owner?: WalletRegistrationIdentity | null;
}) {
  const addressId = useId();
  const [address, setAddress] = useState(savedAddress);
  const [chain, setChain] = useState<WalletChain>(() => {
    try {
      const saved = sessionStorage.getItem("slop-wallet-chain");
      return isWalletChain(saved) ? saved : "solana";
    } catch {
      return "solana";
    }
  });
  const chainLabel = {
    solana: "Solana",
    base: "Base",
    robinhood: "Robinhood Chain",
  }[chain];
  const [canResume, setCanResume] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "signing-in" | "preview" | "registering" | "done"
  >("idle");
  const [message, setMessage] = useState("");
  const [session, setSession] = useState<WalletRegistrationSession | null>(
    null,
  );
  const [registered, setRegistered] = useState<RegisteredWalletClaim | null>(
    null,
  );
  const [registrationRevision, setRegistrationRevision] = useState(0);
  const ownerActorId = owner?.githubActorId;
  const latestOwnerActorId = useRef(ownerActorId);
  latestOwnerActorId.current = ownerActorId;
  const active = useRef<{
    controller: AbortController;
    session?: WalletRegistrationSession;
  } | null>(null);
  const release = () => {
    const run = active.current;
    active.current = null;
    run?.controller.abort();
    run?.session?.cancel();
  };
  useEffect(
    () => () => {
      const run = active.current;
      active.current = null;
      run?.controller.abort();
      run?.session?.cancel();
    },
    [],
  );
  async function start(resume?: WalletAuthorization) {
    const input = canonicalWalletInput(chain, address);
    if ("error" in input) {
      setMessage(input.error);
      return;
    }
    const exactAddress = input.address;
    release();
    // Reserve the popup during the user gesture; never place bearer credentials
    // in the application URL or communicate credentials via postMessage.
    const popup = resume
      ? null
      : window.open("about:blank", "_blank", "popup,width=600,height=720");
    if (popup) popup.opener = null;
    setAuthorizationUrl(null);
    try {
      sessionStorage.setItem(WALLET_ADDRESS, exactAddress);
      sessionStorage.setItem("slop-wallet-chain", chain);
    } catch {
      /* Keep in component state. */
    }
    const run = {
      controller: new AbortController(),
      session: undefined as WalletRegistrationSession | undefined,
    };
    active.current = run;
    setSession(null);
    setRegistered(null);
    setMessage("");
    setPhase("signing-in");
    try {
      const prepared = await prepareWalletRegistration(exactAddress, {
        chain,
        signal: run.controller.signal,
        resume,
        saveAuthorization: (value) => {
          saveAuthorization(value);
          setCanResume(value !== null && pendingAuthorization() !== undefined);
        },
        authorize: (url) => {
          if (popup) popup.location.replace(url);
          else setAuthorizationUrl(url);
        },
      });
      if (active.current !== run) {
        prepared.cancel();
        return;
      }
      setAuthorizationUrl(null);
      run.session = prepared;
      setSession(prepared);
      setPhase("preview");
    } catch (error) {
      if (active.current !== run) return;
      release();
      saveAuthorization(null);
      setAuthorizationUrl(null);
      setPhase("idle");
      setMessage(
        error instanceof Error
          ? error.message
          : "Wallet sign-in failed. Start again.",
      );
    }
  }
  async function confirm() {
    if (!session || !active.current || phase !== "preview") return;
    const run = active.current;
    setPhase("registering");
    setMessage("");
    try {
      const result = await session.confirm();
      if (active.current !== run) return;
      release();
      setSession(null);
      setRegistered(result);
      setPhase("done");
      if (result.githubActorId === latestOwnerActorId.current)
        setRegistrationRevision((value) => value + 1);
    } catch (error) {
      if (active.current !== run) return;
      release();
      setSession(null);
      setPhase("idle");
      setMessage(
        error instanceof Error
          ? error.message
          : "Registration could not be verified. Start again to check the current claim.",
      );
    }
  }
  useEffect(() => {
    const resume = () => {
      const pending = pendingAuthorization();
      if (pending && !active.current) void start(pending);
    };
    resume();
    window.addEventListener("pageshow", resume);
    return () => window.removeEventListener("pageshow", resume);
  });
  const busy = phase === "signing-in" || phase === "registering";
  const step = registered ? 3 : session && phase !== "idle" ? 2 : 1;
  return (
    <section
      aria-labelledby={`${addressId}-heading`}
      className="funding-workbench account-wallets"
      id="wallets"
    >
      <h2 id={`${addressId}-heading`}>Wallets</h2>
      <p>
        Register a public Solana, Base or Robinhood Chain address for awards.
        Registration records a receiving address; it does not authorize payment.
      </p>
      <details>
        <summary>About wallet registration</summary>
        <p>
          You do not connect a wallet, share private keys, or sign anything.
          GitHub confirms your identity again for each change. Registration does
          not prove control of the address. A changed address appends a
          successor record, and wallets in existing cycles stay locked.
        </p>
      </details>
      <ol className="wallet-steps" aria-label="Registration steps">
        {["Address", "Confirm", "Saved"].map((label, index) => (
          <li
            key={label}
            aria-current={step === index + 1 ? "step" : undefined}
          >
            <span>{index + 1}</span> {label}
          </li>
        ))}
      </ol>
      {authorizationUrl && (
        <div role="status">
          <a
            className="button primary-button"
            href={authorizationUrl}
            target={canResume ? undefined : "_blank"}
            rel="noreferrer"
            referrerPolicy="no-referrer"
          >
            Continue to GitHub {canResume ? "in this tab" : "in another tab"}
          </a>
          <p>
            {canResume
              ? "After authorizing, use Back to return here. Your address is saved."
              : "After authorizing, return to this tab to confirm your address."}
          </p>
        </div>
      )}
      <form
        className="owner-form"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label htmlFor={`${addressId}-chain`}>Payout network</label>
        <select
          id={`${addressId}-chain`}
          value={chain}
          disabled={busy || phase === "preview"}
          onChange={(event) => {
            release();
            saveAuthorization(null);
            setChain(event.target.value as WalletChain);
            setAddress("");
            setRegistered(null);
            setMessage("");
            try {
              sessionStorage.setItem("slop-wallet-chain", event.target.value);
              sessionStorage.removeItem(WALLET_ADDRESS);
            } catch {
              /* The in-memory form remains usable. */
            }
          }}
        >
          <option value="solana">Solana</option>
          <option value="base">Base</option>
          <option value="robinhood">Robinhood Chain</option>
        </select>
        {owner && (
          <CurrentWalletRegistration
            key={`${owner.githubActorId}:${chain}:${registrationRevision}`}
            owner={owner}
            chain={chain}
            chainLabel={chainLabel}
          />
        )}
        <label htmlFor={addressId}>{chainLabel} public address</label>
        <input
          id={addressId}
          name="wallet-address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={44}
          required
          disabled={busy || phase === "preview"}
        />
        {(phase === "idle" || phase === "done") && (
          <button className="button primary-button" type="submit">
            Verify with GitHub
          </button>
        )}
      </form>
      {phase === "signing-in" && !authorizationUrl && (
        <p role="status">
          Complete GitHub sign-in using your own account. This expires after
          five minutes. You can cancel here if you close the popup.
        </p>
      )}
      {session && phase === "preview" && (
        <div className="wallet-confirmation">
          <h3 className="wallet-heading">Confirm your public registration</h3>
          <dl>
            <div>
              <dt>GitHub</dt>
              <dd>
                <strong>{session.preview.identity.githubLogin}</strong> (ID{" "}
                {session.preview.identity.githubActorId})
              </dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{chainLabel}</dd>
            </div>
            <div>
              <dt>New address</dt>
              <dd>
                <code className="wallet-address">
                  {session.preview.address}
                </code>
              </dd>
            </div>
            <div>
              <dt>Current address</dt>
              <dd>
                {session.preview.current ? (
                  <code className="wallet-address">
                    {session.preview.current.address}
                  </code>
                ) : (
                  "None"
                )}
              </dd>
            </div>
          </dl>
          <p>
            Sign-in is complete. You can close the GitHub sign-in window. This
            preview expires at {session.preview.expiresAt}.
          </p>
          <p className="wallet-consequence">
            <strong>
              Your GitHub identity and this address become a public, permanent
              record.
            </strong>{" "}
            {session.preview.current
              ? "The new address appends a successor record; the earlier record stays public."
              : "Later changes append a successor record; this record stays public."}
          </p>
          <button
            className="button primary-button"
            type="button"
            onClick={() => void confirm()}
          >
            Register address
          </button>
        </div>
      )}
      {phase === "registering" && (
        <p role="status">Registering and verifying the returned claim…</p>
      )}
      {(busy || phase === "preview") && (
        <button
          className="button"
          type="button"
          onClick={() => {
            const submitted = phase === "registering";
            release();
            saveAuthorization(null);
            setAuthorizationUrl(null);
            setSession(null);
            setPhase("idle");
            setMessage(
              submitted
                ? "Request cancelled. It may have reached the registry; sign in again to check the current claim."
                : "Registration cancelled. No wallet claim was submitted.",
            );
          }}
        >
          Cancel
        </button>
      )}
      {message && <p role="alert">{message}</p>}
      {registered && (
        <div role="status">
          <h3 className="wallet-heading">Wallet registered</h3>
          <dl>
            <div>
              <dt>Network</dt>
              <dd>{chainLabel}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd>
                <code className="wallet-address">{registered.address}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>Saved for {registered.githubLogin}</dd>
            </div>
          </dl>
          <a
            href={`${browserDeployment.api}/api/v1/wallet-claims/${registered.claimId}`}
            target="_blank"
            rel="noreferrer"
          >
            View public record
          </a>
          <details>
            <summary>Technical details</summary>
            <p>Observed: {registered.observedAt}</p>
            <p>
              Record digest:{" "}
              <code className="wallet-address">{registered.recordDigest}</code>
            </p>
          </details>
        </div>
      )}
    </section>
  );
}
