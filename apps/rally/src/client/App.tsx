import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  DollarSign,
  KeyRound,
  Link2,
  LoaderCircle,
  MapPin,
  MessageCircle,
  RefreshCw,
  Send,
  Sparkles,
  Users,
  Utensils,
  Vote as VoteIcon,
  WalletCards,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatTime, initials, pluralize } from "../shared/format";
import type { Constraint, Proposal, RoomSnapshot, Session } from "../shared/types";
import {
  ApiRequestError,
  api,
  loadRecentRooms,
  loadSession,
  personalRoomUrl,
  rememberRoom,
  roomWebSocketProtocols,
  roomWebSocketUrl,
  saveSession,
} from "./api";

const examples = [
  "Plan a birthday dinner in Shanghai next Saturday for six people, around ¥300 each.",
  "Help five friends choose a Sunday hike with an easy trail and a late lunch.",
  "Organize a quiet game night next Friday for eight people under $25 each.",
];

const stages = [
  { key: "started", label: "Started" },
  { key: "collecting", label: "Preferences" },
  { key: "voting", label: "Vote" },
  { key: "finalized", label: "Final plan" },
] as const;

export function App() {
  const [path, setPath] = useState(location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(location.pathname);
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: string) => {
    history.pushState({}, "", next);
    setPath(new URL(next, location.origin).pathname);
  }, []);

  const roomMatch = path.match(/^\/room\/([0-9a-f-]+)$/i);
  if (roomMatch) return <RoomPage roomId={roomMatch[1]} navigate={navigate} />;
  const invitationMatch = path.match(/^\/join\/([0-9a-f-]+)$/i);
  if (invitationMatch) return <InvitationPage roomId={invitationMatch[1]} navigate={navigate} />;
  return <LandingPage navigate={navigate} />;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className={`brand ${compact ? "brand-compact" : ""}`} href="/" aria-label="Rally home">
      <span className="brand-mark"><Sparkles size={compact ? 17 : 20} /></span>
      <span>Rally</span>
    </a>
  );
}

function LandingPage({ navigate }: { navigate: (path: string) => void }) {
  const [prompt, setPrompt] = useState(examples[0]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recentRooms = loadRecentRooms();

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("Add your name so the group knows who started the room.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.createRoom(prompt, name);
      saveSession(result);
      rememberRoom(result, result.snapshot);
      navigate(`/room/${result.roomId}#access=${result.token}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the room");
    } finally {
      setBusy(false);
    }
  }

  function openRecent(roomId: string) {
    const session = loadSession(roomId);
    navigate(session ? `/room/${roomId}#access=${session.token}` : `/room/${roomId}`);
  }

  return (
    <div className="landing-shell">
      <nav className="landing-nav">
        <Brand />
        <span className="nav-note">Make the plan, together.</span>
      </nav>
      <main className="hero">
        <section className="hero-copy">
          <div className="eyebrow"><span className="live-dot" /> AI group planner</div>
          <h1>Skip the group-chat chaos.</h1>
          <p className="hero-lede">
            Rally gathers everyone's constraints, finds the overlap, and turns the conversation into one confirmed plan.
          </p>
          <div className="hero-proof">
            <div><MessageCircle size={18} /><span><strong>Talk naturally</strong><small>No long forms</small></span></div>
            <div><Users size={18} /><span><strong>Plan together</strong><small>One live room</small></span></div>
            <div><CheckCircle2 size={18} /><span><strong>Reach a decision</strong><small>Options and voting</small></span></div>
          </div>
        </section>

        <section className="create-card" aria-labelledby="create-heading">
          <div className="create-card-head">
            <span className="mini-mark"><Sparkles size={16} /></span>
            <div><h2 id="create-heading">What are you planning?</h2><p>Start with whatever you already know.</p></div>
          </div>
          <form onSubmit={createRoom}>
            <label htmlFor="plan-prompt">Describe the plan</label>
            <textarea id="plan-prompt" rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} minLength={8} maxLength={1500} required />
            <label htmlFor="organizer-name">Your name</label>
            <input id="organizer-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="How your friends know you" maxLength={60} required />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button create-button" disabled={busy}>
              {busy ? <><LoaderCircle className="spin" size={18} /> Starting the room…</> : <>Create planning room <ArrowRight size={18} /></>}
            </button>
          </form>
          <div className="example-row" aria-label="Example plans">
            <span>Try:</span>
            {examples.slice(1).map((example, index) => (
              <button type="button" key={example} onClick={() => setPrompt(example)}>{index === 0 ? "Hiking trip" : "Game night"}</button>
            ))}
          </div>
          {recentRooms.length > 0 && <div className="recent-rooms">
            <p>Recent on this device</p>
            {recentRooms.slice(0, 3).map((room) => (
              <button key={room.roomId} type="button" onClick={() => openRecent(room.roomId)}>
                <span><strong>{room.title}</strong><small>{room.participantName} · {room.role}</small></span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>}
        </section>
      </main>
      <footer className="landing-footer">
        <span>Built on Cloudflare Workers AI, Workflows, and Durable Objects</span>
        <span>Keep your private return link to reopen a room anywhere.</span>
      </footer>
    </div>
  );
}

function RoomPage({ roomId, navigate }: { roomId: string; navigate: (path: string) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");

  useEffect(() => {
    let cancelled = false;
    const openRoom = async () => {
      const accessToken = new URLSearchParams(location.hash.slice(1)).get("access");
      const saved = loadSession(roomId);
      const candidate = accessToken
        ? { roomId, participantId: "", role: "participant" as const, token: accessToken }
        : saved;
      if (!candidate) throw new ApiRequestError("Open your private return link, or ask the organizer for a new invitation.", 401);
      const resumed = await api.resumeRoom(roomId, candidate.token);
      if (!cancelled) {
        saveSession(resumed);
        rememberRoom(resumed, resumed.snapshot);
        setSession(resumed);
        setSnapshot(resumed.snapshot);
        setError(null);
      }
    };
    openRoom()
      .catch((caught) => {
        if (!cancelled) setError({
          message: caught instanceof Error ? caught.message : "Could not load room",
          status: caught instanceof ApiRequestError ? caught.status : undefined,
        });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [roomId]);

  useEffect(() => {
    if (!session) return;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let stopped = false;
    const connect = () => {
      if (!navigator.onLine) {
        setConnection("offline");
        return;
      }
      setConnection("connecting");
      socket = new WebSocket(roomWebSocketUrl(session), roomWebSocketProtocols(session));
      socket.onopen = () => setConnection("live");
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { type: string; snapshot?: RoomSnapshot };
          if (payload.type === "snapshot" && payload.snapshot) {
            setSnapshot(payload.snapshot);
            rememberRoom(session, payload.snapshot);
          }
        } catch {
          // Ignore malformed frames and wait for the next canonical snapshot.
        }
      };
      socket.onerror = () => setConnection("offline");
      socket.onclose = () => {
        setConnection("offline");
        if (!stopped && navigator.onLine) retry = window.setTimeout(connect, 1_500);
      };
    };
    const wentOffline = () => {
      setConnection("offline");
      socket?.close(4000, "browser offline");
    };
    const cameOnline = () => {
      if (retry) clearTimeout(retry);
      connect();
    };
    addEventListener("offline", wentOffline);
    addEventListener("online", cameOnline);
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      removeEventListener("offline", wentOffline);
      removeEventListener("online", cameOnline);
      socket?.close(1000, "leaving room");
    };
  }, [session]);

  function updateSession(next: Session, nextSnapshot: RoomSnapshot) {
    saveSession(next);
    rememberRoom(next, nextSnapshot);
    history.replaceState({}, "", `/room/${next.roomId}#access=${next.token}`);
    setSession(next);
    setSnapshot(nextSnapshot);
  }

  if (loading && !snapshot) return <FullPageStatus label="Opening your planning room…" />;
  if (!session || (error && !snapshot)) return <RoomAccessPage error={error} navigate={navigate} />;
  if (!snapshot) return <FullPageStatus label="Connecting to Rally…" />;
  return <PlanningRoom session={session} snapshot={snapshot} setSnapshot={setSnapshot} connection={connection} updateSession={updateSession} />;
}

function RoomAccessPage({ error, navigate }: { error: { message: string; status?: number } | null; navigate: (path: string) => void }) {
  return (
    <div className="join-shell">
      <button className="brand brand-button" type="button" onClick={() => navigate("/")}><span className="brand-mark"><Sparkles size={20} /></span><span>Rally</span></button>
      <section className="join-card">
        <div className="join-illustration"><KeyRound size={30} /></div>
        <p className="eyebrow">Private room</p>
        <h1>Your return link is needed</h1>
        <p>{error?.message ?? "This room opens with the private link created for you when you joined."}</p>
        <button className="primary-button" type="button" onClick={() => navigate("/")}>Back to Rally</button>
      </section>
    </div>
  );
}

function InvitationPage({ roomId, navigate }: { roomId: string; navigate: (path: string) => void }) {
  const invitationToken = new URLSearchParams(location.hash.slice(1)).get("invite") ?? "";
  const [invitation, setInvitation] = useState<{ roomId: string; title: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!invitationToken) {
      setError("This invitation link is incomplete. Ask the organizer to copy it again.");
      return;
    }
    api.invitation(roomId, invitationToken)
      .then(setInvitation)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not open this invitation"));
  }, [roomId, invitationToken]);

  async function join(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const joined = await api.joinRoom(roomId, name, invitationToken);
      saveSession(joined);
      rememberRoom(joined, joined.snapshot);
      navigate(`/room/${joined.roomId}#access=${joined.token}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join this room");
    } finally {
      setBusy(false);
    }
  }

  if (!invitation && !error) return <FullPageStatus label="Opening invitation…" />;
  if (!invitation) return <FullPageError message={error} onBack={() => navigate("/")} />;
  return <div className="join-shell">
    <button className="brand brand-button" type="button" onClick={() => navigate("/")}><span className="brand-mark"><Sparkles size={20} /></span><span>Rally</span></button>
    <section className="join-card">
      <div className="join-illustration"><Users size={30} /></div>
      <p className="eyebrow">You’ve been invited</p>
      <h1>{invitation.title}</h1>
      <p>Choose the name your group will see. Rally will create a private return link just for you.</p>
      <form onSubmit={join}>
        <label htmlFor="invite-name">Your name</label>
        <input id="invite-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" maxLength={60} required />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />} Join planning room</button>
      </form>
    </section>
  </div>;
}

function PlanningRoom({ session, snapshot, setSnapshot, connection, updateSession }: {
  session: Session;
  snapshot: RoomSnapshot;
  setSnapshot: (snapshot: RoomSnapshot) => void;
  connection: "connecting" | "live" | "offline";
  updateSession: (session: Session, snapshot: RoomSnapshot) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [accessOpen, setAccessOpen] = useState(false);
  const [copied, setCopied] = useState<"invite" | "return" | "">("");
  const [displayName, setDisplayName] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const me = snapshot.participants.find((participant) => participant.id === session.participantId);
  const isOrganizer = me?.role === "organizer";

  useEffect(() => { setDisplayName(me?.displayName ?? ""); }, [me?.displayName]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ block: "nearest" });
  }, [snapshot.messages.length]);

  async function run(label: string, operation: () => Promise<RoomSnapshot>) {
    setBusy(label);
    setError("");
    try { setSnapshot(await operation()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Something went wrong"); }
    finally { setBusy(""); }
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    const body = message.trim();
    if (!body || busy === "message") return;
    setMessage("");
    await run("message", () => api.sendMessage(session, body, crypto.randomUUID()));
  }

  async function copyInvite() {
    setError("");
    try {
      const { invitationUrl } = await api.createInvitation(session);
      await navigator.clipboard.writeText(invitationUrl);
      setCopied("invite");
      setTimeout(() => setCopied(""), 1_500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create an invitation");
    }
  }

  async function copyReturnLink() {
    await navigator.clipboard.writeText(personalRoomUrl(session));
    setCopied("return");
    setTimeout(() => setCopied(""), 1_500);
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    await run("rename", () => api.renameParticipant(session, displayName));
  }

  async function rotateReturnLink() {
    setBusy("rotate");
    setError("");
    try {
      const next = await api.rotateAccess(session);
      updateSession(next, next.snapshot);
      await navigator.clipboard.writeText(personalRoomUrl(next));
      setCopied("return");
      setTimeout(() => setCopied(""), 1_500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not replace your return link");
    } finally { setBusy(""); }
  }

  return (
    <div className="room-shell">
      <header className="room-topbar">
        <div className="room-brand-group">
          <Brand compact />
          <div className="room-heading"><span>{snapshot.room.stage === "finalized" ? "Final plan" : "Planning room"}</span><h1>{snapshot.room.title}</h1></div>
        </div>
        <div className="room-actions">
          <span className={`connection ${connection}`}><span />{connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting"}</span>
          <AvatarStack participants={snapshot.participants} />
          <button className="secondary-button invite-button" type="button" aria-expanded={accessOpen} onClick={() => setAccessOpen((open) => !open)}><Link2 size={16} /> Share & access</button>
          {accessOpen && <section className="access-menu" aria-label="Share and access settings">
            {isOrganizer && <div className="access-action"><span><strong>Invite people</strong><small>Anyone with this link can join as themselves.</small></span><button className="primary-button" type="button" onClick={copyInvite}>{copied === "invite" ? <Check size={15} /> : <Copy size={15} />}{copied === "invite" ? "Copied" : "Copy invite"}</button></div>}
            <div className="access-action"><span><strong>Your private return link</strong><small>Keep this private. It opens the room as you.</small></span><button className="secondary-button" type="button" onClick={copyReturnLink}>{copied === "return" ? <Check size={15} /> : <KeyRound size={15} />}{copied === "return" ? "Copied" : "Copy my link"}</button></div>
            <form className="rename-form" onSubmit={rename}><label htmlFor="display-name">Name shown in this room</label><div><input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={60} required /><button className="secondary-button" disabled={busy === "rename"}>Save</button></div></form>
            <button className="text-button rotate-link" type="button" disabled={busy === "rotate"} onClick={rotateReturnLink}>Replace my return link</button>
          </section>}
        </div>
      </header>
      <StageBar stage={snapshot.room.stage} />
      <main className="room-layout">
        <section className="conversation-panel">
          <div className="panel-heading"><div><h2>Group chat</h2><p>Rally turns the conversation into a shared plan.</p></div><span>{peopleLabel(snapshot.participants.length)}</span></div>
          <div className="message-list" aria-live="polite">
            {snapshot.messages.map((item) => {
              if (item.kind === "system") return <div className="system-message" key={item.id}>{item.body}</div>;
              const mine = item.participantId === session.participantId;
              return (
                <article className={`message ${mine ? "mine" : ""} ${item.kind === "agent" ? "agent" : ""}`} key={item.id}>
                  {!mine && <span className="message-avatar">{item.kind === "agent" ? <Sparkles size={14} /> : initials(item.participantName)}</span>}
                  <div className="message-body">
                    <div className="message-meta"><strong>{mine ? "You" : item.participantName}</strong><time>{formatTime(item.createdAt)}</time></div>
                    <p>{item.body}</p>
                  </div>
                </article>
              );
            })}
            <div ref={messageEnd} />
          </div>
          <form className="composer" onSubmit={submitMessage}>
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Add a preference or ask Rally…" maxLength={2000} aria-label="Message the group" />
            <button className="primary-button icon-button" disabled={!message.trim() || busy === "message"} aria-label="Send message">
              {busy === "message" ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
            </button>
          </form>
          {error && <div className="inline-error" role="alert">{error}</div>}
        </section>
        <PlanningBoard
          session={session}
          snapshot={snapshot}
          isOrganizer={Boolean(isOrganizer)}
          busy={busy}
          run={run}
        />
      </main>
    </div>
  );
}

function AvatarStack({ participants }: { participants: RoomSnapshot["participants"] }) {
  const shown = participants.slice(0, 3);
  return <div className="avatar-stack" aria-label={`${participants.length} participants`}>
    {shown.map((participant) => <span key={participant.id} title={participant.displayName}>{initials(participant.displayName)}</span>)}
    {participants.length > 3 && <span>+{participants.length - 3}</span>}
  </div>;
}

function StageBar({ stage }: { stage: RoomSnapshot["room"]["stage"] }) {
  const active = stage === "collecting" ? 1 : stage === "generating" || stage === "voting" ? 2 : 3;
  return <div className="stage-bar" aria-label="Planning progress">
    {stages.map((item, index) => (
      <div key={item.key} className={`stage-item ${index < active ? "done" : ""} ${index === active ? "active" : ""}`}>
        <span>{index < active ? <Check size={12} /> : index + 1}</span><strong>{item.label}</strong>
      </div>
    ))}
  </div>;
}

function PlanningBoard({ session, snapshot, isOrganizer, busy, run }: {
  session: Session;
  snapshot: RoomSnapshot;
  isOrganizer: boolean;
  busy: string;
  run: (label: string, operation: () => Promise<RoomSnapshot>) => Promise<void>;
}) {
  const myVote = snapshot.votes.find((vote) => vote.participantId === session.participantId && vote.value === 1)?.proposalId;
  const finalized = snapshot.proposals.find((proposal) => proposal.id === snapshot.room.finalizedProposalId);

  return (
    <aside className="plan-panel">
      <div className="panel-heading"><div><h2>{snapshot.room.stage === "finalized" ? "Final plan" : "Your plan"}</h2><p>{planSubtitle(snapshot)}</p></div></div>
      <div className="plan-scroll">
        {snapshot.room.stage === "finalized" && finalized ? (
          <FinalPlan proposal={finalized} snapshot={snapshot} />
        ) : snapshot.room.stage === "generating" ? (
          <GeneratingPanel />
        ) : snapshot.room.stage === "voting" && snapshot.proposals.length ? (
          <ProposalList
            proposals={snapshot.proposals}
            myVote={myVote}
            isOrganizer={isOrganizer}
            busy={busy}
            onVote={(id) => run(`vote:${id}`, () => api.vote(session, id))}
            onFinalize={(id) => run(`finalize:${id}`, () => api.finalize(session, id))}
          />
        ) : (
          <>
            <section className="plan-card next-step-card">
              <span className="next-step-label">Next step</span>
              <h3>{snapshot.constraints.length ? "Ready to make options?" : "Add the plan details"}</h3>
              <p>{snapshot.constraints.length ? "Invite others to add their must-haves, or let Rally create three plans from what it knows now." : "Use the chat to share the date, location, budget, and anything the group needs."}</p>
              {isOrganizer ? (
                <button className="primary-button" type="button" disabled={busy === "generate"} onClick={() => run("generate", () => api.generateProposals(session))}>
                  {busy === "generate" ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} Create three options
                </button>
              ) : <span className="waiting-note"><Clock3 size={15} /> Waiting for the organizer to create options</span>}
            </section>
            <ConstraintBoard constraints={snapshot.constraints} />
          </>
        )}
      </div>
    </aside>
  );
}

function ConstraintBoard({ constraints }: { constraints: Constraint[] }) {
  const iconFor = (type: Constraint["type"]) => {
    if (type === "date") return <CalendarDays size={15} />;
    if (type === "time") return <Clock3 size={15} />;
    if (type === "location") return <MapPin size={15} />;
    if (type === "budget") return <WalletCards size={15} />;
    if (type === "dietary") return <Utensils size={15} />;
    if (type === "attendance") return <Users size={15} />;
    return <CheckCircle2 size={15} />;
  };
  return <section className="plan-card constraint-card">
    <div className="card-title-row"><h3>Plan details</h3><span>{pluralize(constraints.length, "detail")}</span></div>
    {constraints.length ? <div className="constraint-list">
      {constraints.map((constraint) => <div className="constraint-row" key={constraint.id}>
        <span className="constraint-icon">{iconFor(constraint.type)}</span>
        <span className="constraint-value"><strong>{constraint.value}</strong><small>{constraint.type} · {constraint.participantName}</small></span>
        <span className={`status-chip ${constraint.strength === "hard" ? "hard" : "soft"}`}>{constraint.strength === "hard" ? "Must" : "Prefer"}</span>
      </div>)}
    </div> : <div className="empty-state"><MessageCircle size={22} /><p>Planning details will appear here as people chat.</p></div>}
  </section>;
}

function ProposalList({ proposals, myVote, isOrganizer, busy, onVote, onFinalize }: {
  proposals: Proposal[];
  myVote?: string;
  isOrganizer: boolean;
  busy: string;
  onVote: (id: string) => void;
  onFinalize: (id: string) => void;
}) {
  return <div className="proposal-list">
    <div className="proposal-intro"><VoteIcon size={18} /><div><h3>Three ways this could work</h3><p>Vote for the plan you would actually join.</p></div></div>
    {proposals.map((proposal, index) => (
      <article className={`proposal-card ${myVote === proposal.id ? "selected" : ""}`} key={proposal.id}>
        <div className="proposal-rank">{index + 1}</div>
        <div className="proposal-head"><div><h3>{proposal.title}</h3><p>{proposal.summary}</p></div>{index === 0 && <span className="status-chip best">Best fit</span>}</div>
        <dl className="proposal-facts">
          <div><dt><Clock3 size={14} /> When</dt><dd>{proposal.details.when}</dd></div>
          <div><dt><MapPin size={14} /> Where</dt><dd>{proposal.details.where}</dd></div>
          <div><dt><DollarSign size={14} /> Budget</dt><dd>{proposal.details.cost}</dd></div>
        </dl>
        {proposal.tradeoffs.length > 0 && <p className="tradeoff"><strong>Tradeoff:</strong> {proposal.tradeoffs[0]}</p>}
        <div className="proposal-actions">
          <button className={myVote === proposal.id ? "primary-button" : "secondary-button"} disabled={busy === `vote:${proposal.id}`} onClick={() => onVote(proposal.id)}>
            {busy === `vote:${proposal.id}` ? <LoaderCircle className="spin" size={15} /> : myVote === proposal.id ? <Check size={15} /> : <VoteIcon size={15} />}
            {myVote === proposal.id ? "Your vote" : "Vote"}
          </button>
          <span>{pluralize(proposal.votes, "vote")}</span>
          {isOrganizer && <button className="text-button" disabled={busy === `finalize:${proposal.id}`} onClick={() => onFinalize(proposal.id)}>Finalize <ChevronRight size={14} /></button>}
        </div>
      </article>
    ))}
  </div>;
}

function GeneratingPanel() {
  return <section className="generating-panel">
    <span className="generating-icon"><Sparkles size={28} /></span>
    <h3>Finding the best overlap</h3>
    <p>Rally is checking every hard constraint, comparing tradeoffs, and building three viable options.</p>
    <div className="progress-line"><span /></div>
    <small>This Workflow can safely resume if execution is interrupted.</small>
  </section>;
}

function FinalPlan({ proposal, snapshot }: { proposal: Proposal; snapshot: RoomSnapshot }) {
  return <div className="final-plan">
    <section className="celebration-card">
      <span><CheckCircle2 size={23} /></span>
      <p>It's settled</p>
      <h3>{proposal.title}</h3>
      <p>{proposal.summary}</p>
    </section>
    <section className="plan-card final-details">
      <div><span><Clock3 size={16} /></span><p><small>When</small><strong>{proposal.details.when}</strong></p></div>
      <div><span><MapPin size={16} /></span><p><small>Where</small><strong>{proposal.details.where}</strong></p></div>
      <div><span><WalletCards size={16} /></span><p><small>Budget</small><strong>{proposal.details.cost}</strong></p></div>
      <div><span><Users size={16} /></span><p><small>Group</small><strong>{peopleLabel(snapshot.participants.length)}</strong></p></div>
    </section>
    <section className="plan-card checklist">
      <div className="card-title-row"><h3>Before you go</h3><span>{proposal.details.notes.length}</span></div>
      {proposal.details.notes.map((note) => <p key={note}><Check size={14} />{note}</p>)}
    </section>
  </div>;
}

function planSubtitle(snapshot: RoomSnapshot): string {
  if (snapshot.room.stage === "generating") return "A durable Workflow is building the shortlist";
  if (snapshot.room.stage === "voting") return `${snapshot.votes.filter((vote) => vote.value === 1).length} votes cast`;
  if (snapshot.room.stage === "finalized") return "Confirmed by the organizer";
  return `${snapshot.participants.length} joined · ${snapshot.constraints.length} details captured`;
}

function peopleLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function FullPageStatus({ label }: { label: string }) {
  return <div className="full-status"><Brand /><LoaderCircle className="spin" size={26} /><p>{label}</p></div>;
}

function FullPageError({ message, onBack }: { message: string; onBack: () => void }) {
  return <div className="full-status"><Brand /><h1>That room could not be opened</h1><p>{message}</p><button className="primary-button" onClick={onBack}><RefreshCw size={17} /> Start a new room</button></div>;
}
