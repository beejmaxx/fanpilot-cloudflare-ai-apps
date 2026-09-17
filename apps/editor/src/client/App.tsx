import { useEffect, useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import UniqueID from "@tiptap/extension-unique-id";
import {
  Bold, Check, CheckCircle2, ChevronLeft, Clock3, Cloud, CloudOff, Code2, Copy,
  FileText, Heading2, History, Italic, Link2, List, ListOrdered, MessageCircle,
  MoreHorizontal, PanelRight, Plus, Redo2, Send, Share2, Sparkles, Users, X,
} from "lucide-react";
import * as Y from "yjs";
import type { DocumentSnapshot, PanelName, ParticipantRole } from "../shared/types";
import * as api from "./api";
import { DraftProvider } from "./provider";
import { forgetDocument, recentDocuments, savedDocument, saveDocument, type SavedDocument } from "./storage";
import { Turnstile } from "./Turnstile";

const colors = ["#6554e8", "#0b8f74", "#d25f3f", "#1b74c8", "#a443a7"];

export default function App() {
  const route = parseRoute();
  if (route.kind === "document") return <DocumentPage documentId={route.documentId} fragmentToken={route.token} />;
  if (route.kind === "join") return <JoinPage documentId={route.documentId} inviteToken={route.token} />;
  return <HomePage />;
}

function HomePage() {
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReset, setTurnstileReset] = useState(0);
  const recent = recentDocuments();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = await api.createDocument({ title, displayName: name, template, turnstileToken });
      saveDocument({ id: result.documentId, title, participantId: result.participantId, token: result.accessToken, updatedAt: Date.now() });
      location.href = `/doc/${result.documentId}#access=${result.accessToken}`;
    } catch (reason) {
      setError(messageOf(reason)); setBusy(false); setTurnstileReset((value) => value + 1);
    }
  }

  return <main className="home-shell">
    <nav className="home-nav"><Brand /><span className="demo-pill"><Cloud size={14} /> Built on Cloudflare</span></nav>
    <section className="hero-grid">
      <div className="hero-copy">
        <span className="eyebrow"><Sparkles size={15} /> Collaborative writing, with an editor you control</span>
        <h1>Write together.<br /><em>Edit with AI.</em></h1>
        <p>Draft product specs and proposals with your team. Ask AI for changes, inspect every diff, and decide what belongs in the document.</p>
        <div className="trust-row"><span><Users size={17} /> Live collaboration</span><span><CheckCircle2 size={17} /> Reviewable AI edits</span><span><Clock3 size={17} /> Durable history</span></div>
      </div>
      <form className="create-card" onSubmit={submit}>
        <div><span className="step-label">NEW DOCUMENT</span><h2>Start a shared draft</h2><p>You’ll get a private return link and separate links for collaborators.</p></div>
        <label>Document title<input autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Q4 launch proposal" /></label>
        <label>Your name<input required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} placeholder="Bijan" /></label>
        <fieldset><legend>Start from</legend><div className="template-grid">
          {[{ id: "blank", label: "Blank", icon: FileText }, { id: "product-spec", label: "Product spec", icon: Code2 }, { id: "proposal", label: "Proposal", icon: Sparkles }].map((item) => <button key={item.id} type="button" className={template === item.id ? "template active" : "template"} onClick={() => setTemplate(item.id)}><item.icon size={19} />{item.label}</button>)}
        </div></fieldset>
        <Turnstile onToken={setTurnstileToken} resetSignal={turnstileReset} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary wide" disabled={busy || !turnstileToken}>{busy ? "Creating…" : turnstileToken ? "Create document" : "Checking browser…"}<Plus size={18} /></button>
      </form>
    </section>
    {recent.length > 0 && <section className="recent-section"><h2>Recent on this device</h2><div className="recent-grid">{recent.map((item) => <a key={item.id} href={`/doc/${item.id}#access=${item.token}`}><FileText size={20} /><span><strong>{item.title}</strong><small>Private return link saved locally</small></span></a>)}</div></section>}
  </main>;
}

function JoinPage({ documentId, inviteToken }: { documentId: string; inviteToken: string }) {
  const [info, setInfo] = useState<{ title: string; role: ParticipantRole } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const existing = savedDocument(documentId);

  useEffect(() => { api.invitationInfo(documentId, inviteToken).then(setInfo).catch((reason) => setError(messageOf(reason))); }, [documentId, inviteToken]);
  async function join(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api.joinDocument(documentId, { displayName: name, inviteToken });
      saveDocument({ id: documentId, title: result.snapshot.document.title, participantId: result.participantId, token: result.accessToken, updatedAt: Date.now() });
      location.href = `/doc/${documentId}#access=${result.accessToken}`;
    } catch (reason) { setError(messageOf(reason)); setBusy(false); }
  }
  return <main className="center-page"><a href="/" className="back-link"><ChevronLeft size={17} /> Draft</a><form className="join-card" onSubmit={join}>
    <div className="join-icon"><Users /></div><span className="step-label">DOCUMENT INVITATION</span><h1>{info?.title ?? "Opening invitation…"}</h1>
    {info && <p>You were invited as {article(info.role)} <strong>{info.role}</strong>. This invitation can be used once.</p>}
    {existing && <a className="secondary wide" href={`/doc/${documentId}#access=${existing.token}`}>Continue as your saved identity</a>}
    {existing && <div className="or"><span>or join as someone new</span></div>}
    <label>Your name<input required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} placeholder="How collaborators will see you" /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary wide" disabled={!info || busy}>{busy ? "Joining…" : "Join document"}</button>
    <small>Names do not identify people. This creates a separate private identity even if someone else uses the same name.</small>
  </form></main>;
}

function DocumentPage({ documentId, fragmentToken }: { documentId: string; fragmentToken: string }) {
  const local = savedDocument(documentId);
  const token = fragmentToken || local?.token || "";
  const [snapshot, setSnapshot] = useState<DocumentSnapshot | null>(null);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const [collaboration, setCollaboration] = useState<{ document: Y.Doc; provider: DraftProvider } | null>(null);

  useEffect(() => {
    if (fragmentToken) history.replaceState(null, "", `/doc/${documentId}`);
    if (!token) return;
    let provider: DraftProvider | null = null;
    api.session(documentId, token).then(({ snapshot: value }) => {
      setSnapshot(value);
      saveDocument({ id: documentId, title: value.document.title, participantId: value.participant.id, token, updatedAt: Date.now() });
      const document = new Y.Doc();
      provider = new DraftProvider(document, documentId, token, value.participant.id);
      provider.setUser({ name: value.participant.displayName, color: colors[value.participants.findIndex((person) => person.id === value.participant.id) % colors.length] });
      provider.on("status", (status) => setConnection(String(status)));
      provider.on("snapshot", (next) => {
        const current = next as DocumentSnapshot;
        setSnapshot(current);
        saveDocument({ id: documentId, title: current.document.title, participantId: current.participant.id, token, updatedAt: Date.now() });
      });
      provider.on("error", (reason) => setError(String(reason)));
      setCollaboration({ document, provider });
    }).catch((reason) => setError(messageOf(reason)));
    return () => { provider?.destroy(); };
  }, [documentId, token, fragmentToken]);

  if (!token) return <AccessMissing documentId={documentId} />;
  if (error && !snapshot) return <ErrorPage message={error} />;
  if (!snapshot || !collaboration) return <LoadingPage />;
  return <EditorWorkspace documentId={documentId} token={token} snapshot={snapshot} setSnapshot={setSnapshot} collaboration={collaboration} connection={connection} error={error} setError={setError} />;
}

function EditorWorkspace({ documentId, token, snapshot, setSnapshot, collaboration, connection, error, setError }: {
  documentId: string; token: string; snapshot: DocumentSnapshot; setSnapshot: (value: DocumentSnapshot) => void;
  collaboration: { document: Y.Doc; provider: DraftProvider }; connection: string; error: string; setError: (value: string) => void;
}) {
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [selectedBlocks, setSelectedBlocks] = useState<string[]>([]);
  const [title, setTitle] = useState(snapshot.document.title);
  const readOnly = snapshot.participant.role === "viewer";
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      UniqueID.configure({ attributeName: "blockId", types: ["paragraph", "heading"] }),
      Collaboration.configure({ document: collaboration.document, field: "content" }),
      CollaborationCaret.configure({ provider: collaboration.provider as never, user: { name: snapshot.participant.displayName, color: colors[0] } }),
    ],
    editable: !readOnly,
    editorProps: { attributes: { class: "draft-editor", "aria-label": "Shared document editor" } },
    onSelectionUpdate: ({ editor: current }) => {
      const ids = new Set<string>();
      const { from, to } = current.state.selection;
      current.state.doc.nodesBetween(from, to || from, (node) => { if (node.attrs.blockId) ids.add(node.attrs.blockId); });
      if (!ids.size) {
        const resolved = current.state.doc.resolve(from);
        for (let depth = resolved.depth; depth > 0; depth -= 1) {
          const id = resolved.node(depth).attrs.blockId;
          if (id) { ids.add(id); break; }
        }
      }
      setSelectedBlocks([...ids]);
    },
  }, [collaboration]);

  useEffect(() => { collaboration.provider.setUser({ name: snapshot.participant.displayName, color: colors[snapshot.participants.findIndex((p) => p.id === snapshot.participant.id) % colors.length] }); }, [snapshot.participant.displayName, snapshot.participants, collaboration.provider]);
  useEffect(() => setTitle(snapshot.document.title), [snapshot.document.title]);

  async function saveTitle() {
    if (title.trim() === snapshot.document.title || !title.trim()) return;
    try { setSnapshot(await api.updateTitle(documentId, token, title.trim())); } catch (reason) { setError(messageOf(reason)); }
  }

  const unresolved = snapshot.comments.filter((comment) => !comment.resolved).length;
  const pending = snapshot.suggestions.filter((suggestion) => suggestion.status === "pending").length;
  return <div className={panel ? "workspace panel-open" : "workspace"}>
    <header className="editor-header">
      <a className="brand-compact" href="/" aria-label="Draft home"><Logo /></a>
      <div className="title-stack"><input className="document-title" value={title} readOnly={readOnly} onChange={(event) => setTitle(event.target.value)} onBlur={saveTitle} aria-label="Document title" /><SaveState status={connection} /></div>
      <div className="header-actions"><AvatarStack participants={snapshot.participants} /><button className="quiet" onClick={() => setPanel("share")}><Share2 size={17} /> Share</button><button className="primary" onClick={() => setPanel("ai")}><Sparkles size={17} /> Ask AI{pending > 0 && <b>{pending}</b>}</button><button className="icon-button mobile-panel" onClick={() => setPanel(panel ? null : "ai")} aria-label="Open side panel"><PanelRight size={20} /></button></div>
    </header>
    <div className="editor-body">
      <main className="document-area">
        {!readOnly && <Toolbar editor={editor} selectedBlocks={selectedBlocks} onAI={() => setPanel("ai")} onComment={() => setPanel("comments")} />}
        <div className="paper"><EditorContent editor={editor} /></div>
      </main>
      {panel && <aside className="side-panel"><PanelHeader panel={panel} setPanel={setPanel} counts={{ pending, unresolved }} />
        <div className="panel-content">
          {panel === "ai" && <AiPanel documentId={documentId} token={token} snapshot={snapshot} setSnapshot={setSnapshot} selectedBlocks={selectedBlocks} provider={collaboration.provider} setError={setError} />}
          {panel === "comments" && <CommentsPanel documentId={documentId} token={token} snapshot={snapshot} setSnapshot={setSnapshot} selectedBlocks={selectedBlocks} setError={setError} />}
          {panel === "history" && <HistoryPanel documentId={documentId} token={token} snapshot={snapshot} setSnapshot={setSnapshot} setError={setError} />}
          {panel === "share" && <SharePanel documentId={documentId} token={token} snapshot={snapshot} setSnapshot={setSnapshot} setError={setError} />}
        </div></aside>}
    </div>
    {error && <div className="toast" role="alert">{error}<button onClick={() => setError("")}><X size={15} /></button></div>}
  </div>;
}

function Toolbar({ editor, selectedBlocks, onAI, onComment }: { editor: ReturnType<typeof useEditor>; selectedBlocks: string[]; onAI: () => void; onComment: () => void }) {
  if (!editor) return null;
  return <div className="toolbar" aria-label="Formatting toolbar">
    <button className={editor.isActive("bold") ? "active" : ""} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold"><Bold /></button>
    <button className={editor.isActive("italic") ? "active" : ""} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic"><Italic /></button><i />
    <button className={editor.isActive("heading", { level: 2 }) ? "active" : ""} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} aria-label="Heading"><Heading2 /></button>
    <button className={editor.isActive("bulletList") ? "active" : ""} onClick={() => editor.chain().focus().toggleBulletList().run()} aria-label="Bulleted list"><List /></button>
    <button className={editor.isActive("orderedList") ? "active" : ""} onClick={() => editor.chain().focus().toggleOrderedList().run()} aria-label="Numbered list"><ListOrdered /></button><i />
    <button onClick={() => editor.chain().focus().undo().run()} aria-label="Undo"><ChevronLeft /></button>
    <button onClick={() => editor.chain().focus().redo().run()} aria-label="Redo"><Redo2 /></button>
    {selectedBlocks.length > 0 && <div className="selection-actions"><span>{selectedBlocks.length === 1 ? "Paragraph selected" : `${selectedBlocks.length} paragraphs selected`}</span><button onClick={onComment}><MessageCircle /> Comment</button><button onClick={onAI}><Sparkles /> Ask AI</button></div>}
  </div>;
}

function AiPanel({ documentId, token, snapshot, setSnapshot, selectedBlocks, provider, setError }: PanelProps & { selectedBlocks: string[]; provider: DraftProvider }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const suggestions = snapshot.suggestions;
  async function submit(instruction = prompt, forceScope?: "advice") {
    if (busy || !instruction.trim()) return;
    setBusy(true); setError("");
    try {
      await provider.whenSaved();
      const scope = forceScope ?? (selectedBlocks.length ? "selection" : "document");
      const result = await api.askAI(documentId, token, { instruction, scope, blockIds: selectedBlocks });
      setSnapshot(result.snapshot); setPrompt("");
    } catch (reason) { setError(messageOf(reason)); } finally { setBusy(false); }
  }
  async function decide(id: string, decision: "accept" | "reject") {
    try { const result = await api.decideSuggestion(documentId, token, id, decision); setSnapshot(result.snapshot); } catch (reason) { setError(messageOf(reason)); }
  }
  async function acceptSet(jobId: string) {
    try { const result = await api.acceptAll(documentId, token, jobId); setSnapshot(result.snapshot); } catch (reason) { setError(messageOf(reason)); }
  }
  const pendingByJob = suggestions.filter((item) => item.status === "pending").reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.jobId]: (counts[item.jobId] ?? 0) + 1 }), {});
  return <div className="ai-panel">
    <section className="panel-intro"><div className="ai-orb"><Sparkles /></div><div><h3>What should change?</h3><p>{selectedBlocks.length ? `Your request will apply to ${selectedBlocks.length === 1 ? "the selected paragraph" : `${selectedBlocks.length} selected paragraphs`}.` : "Your request will consider the whole document."}</p></div></section>
    <div className="quick-actions">{["Make it clearer", "Shorten this", "Flag unanswered questions"].map((action) => <button key={action} disabled={busy} onClick={() => submit(action, action.startsWith("Flag") ? "advice" : undefined)}>{action}</button>)}</div>
    <form className="prompt-box" onSubmit={(event) => { event.preventDefault(); submit(); }}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (!busy && prompt.trim()) event.currentTarget.form?.requestSubmit();
    }} maxLength={2000} placeholder="Ask for a rewrite or feedback…" /><button disabled={busy || !prompt.trim()} aria-label="Send AI request"><Send /></button></form>
    {snapshot.activeJob && <div className="working"><span /> Draft AI is preparing reviewable changes…</div>}
    {suggestions.length > 0 && <section className="suggestions"><div className="section-heading"><h3>Suggestions</h3><span>{suggestions.filter((item) => item.status === "pending").length} to review</span></div>{Object.entries(pendingByJob).some(([, count]) => count > 1) && snapshot.participant.role !== "viewer" && <div className="accept-all-row">{Object.entries(pendingByJob).filter(([, count]) => count > 1).slice(0, 1).map(([jobId, count]) => <button key={jobId} onClick={() => acceptSet(jobId)}><CheckCircle2 /> Accept all {count} changes</button>)}</div>}{suggestions.map((suggestion) => <article className={`suggestion ${suggestion.status}`} key={suggestion.id}>
      <div className="suggestion-meta"><span>{suggestion.requesterName} asked Draft AI</span><StatusPill status={suggestion.status} /></div>
      {suggestion.status === "pending" && snapshot.participant.role !== "viewer" && <div className="decision-row"><button className="accept" onClick={() => decide(suggestion.id, "accept")}><Check /> Accept</button><button onClick={() => decide(suggestion.id, "reject")}><X /> Reject</button></div>}
      <div className="diff"><div><small>BEFORE</small><p>{suggestion.beforeText || <em>Empty paragraph</em>}</p></div><div><small>PROPOSED</small><p>{suggestion.afterText || <em>Empty paragraph</em>}</p></div></div>
      <p className="rationale">{suggestion.rationale}</p>
    </article>)}</section>}
    {snapshot.chatMessages.length > 0 && <section className="chat-log"><h3>Shared AI chat</h3>{snapshot.chatMessages.map((message) => <div className={message.kind} key={message.id}><strong>{message.participantName}</strong><p>{message.body}</p></div>)}</section>}
  </div>;
}

function CommentsPanel({ documentId, token, snapshot, setSnapshot, selectedBlocks, setError }: PanelProps & { selectedBlocks: string[] }) {
  const [body, setBody] = useState("");
  async function add(event: React.FormEvent) { event.preventDefault(); if (!selectedBlocks[0]) return; try { setSnapshot(await api.createComment(documentId, token, selectedBlocks[0], body)); setBody(""); } catch (reason) { setError(messageOf(reason)); } }
  async function toggle(id: string, resolved: boolean) { try { setSnapshot(await api.resolveComment(documentId, token, id, resolved)); } catch (reason) { setError(messageOf(reason)); } }
  return <div><section className="panel-intro compact"><div><h3>Paragraph comments</h3><p>Select or place the cursor in a paragraph to start a thread.</p></div></section>
    {snapshot.participant.role !== "viewer" && <form className="comment-form" onSubmit={add}><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={selectedBlocks.length ? "Add a comment…" : "Select a paragraph first"} disabled={!selectedBlocks.length} /><button className="primary" disabled={!body.trim() || !selectedBlocks.length}>Comment</button></form>}
    <div className="comment-list">{snapshot.comments.length ? snapshot.comments.map((comment) => <article className={comment.resolved ? "resolved" : ""} key={comment.id}><div><strong>{comment.participantName}</strong><small>{new Date(comment.createdAt).toLocaleString()}</small></div><p>{comment.body}</p>{snapshot.participant.role !== "viewer" && <button onClick={() => toggle(comment.id, !comment.resolved)}>{comment.resolved ? "Reopen" : "Resolve"}</button>}</article>) : <EmptyState icon={MessageCircle} title="No comments yet" text="Comments stay attached to a paragraph for the whole team." />}</div>
  </div>;
}

function HistoryPanel({ documentId, token, snapshot, setSnapshot, setError }: PanelProps) {
  async function download(format: "markdown" | "text") { try { const body = await api.exportDocument(documentId, token, format); const blob = new Blob([body], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${safeName(snapshot.document.title)}.${format === "markdown" ? "md" : "txt"}`; link.click(); URL.revokeObjectURL(link.href); } catch (reason) { setError(messageOf(reason)); } }
  return <div><section className="panel-intro compact"><div><h3>History & export</h3><p>Accepted AI edits create a durable recovery point.</p></div></section><div className="export-row"><button onClick={() => download("markdown")}><FileText /> Markdown</button><button onClick={() => download("text")}><FileText /> Plain text</button></div>
    <div className="revision-list">{snapshot.revisions.length ? snapshot.revisions.map((revision) => <article key={revision.id}><History /><div><strong>{revision.label}</strong><span>{revision.actorName} · {new Date(revision.createdAt).toLocaleString()}</span></div>{revision.canRevert && snapshot.participant.role !== "viewer" && <button className="revision-revert" onClick={async () => { try { const result = await api.revertRevision(documentId, token, revision.id); setSnapshot(result.snapshot); } catch (reason) { setError(messageOf(reason)); } }}>Revert</button>}<button onClick={() => navigator.clipboard.writeText(revision.exportText)} aria-label="Copy historical version"><Copy /></button></article>) : <EmptyState icon={History} title="No AI revisions yet" text="A recovery point appears here before each accepted AI edit." />}</div></div>;
}

function SharePanel({ documentId, token, snapshot, setSnapshot, setError }: PanelProps) {
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [link, setLink] = useState("");
  async function create() { try { const result = await api.createInvite(documentId, token, role); setLink(`${location.origin}/join/${documentId}#invite=${result.inviteToken}`); } catch (reason) { setError(messageOf(reason)); } }
  async function changeName() { const displayName = prompt("How should collaborators see your name?", snapshot.participant.displayName); if (!displayName?.trim()) return; try { setSnapshot(await api.rename(documentId, token, displayName)); } catch (reason) { setError(messageOf(reason)); } }
  async function rotateLink() { try { const result = await api.rotateAccess(documentId, token); saveDocument({ id: documentId, title: snapshot.document.title, participantId: snapshot.participant.id, token: result.accessToken, updatedAt: Date.now() }); location.href = `/doc/${documentId}#access=${result.accessToken}`; } catch (reason) { setError(messageOf(reason)); } }
  async function revoke(id: string) { try { setSnapshot(await api.revokeParticipant(documentId, token, id)); } catch (reason) { setError(messageOf(reason)); } }
  function forget() { forgetDocument(documentId); location.href = "/"; }
  return <div><section className="panel-intro compact"><div><h3>Share this document</h3><p>Each person gets a distinct private identity. Display names can be the same.</p></div></section>
    {snapshot.participant.role === "owner" ? <div className="share-controls"><label>Invite as<select value={role} onChange={(event) => setRole(event.target.value as "editor" | "viewer")}><option value="editor">Editor — can write and use AI</option><option value="viewer">Viewer — read only</option></select></label><button className="primary wide" onClick={create}><Link2 /> Create invite link</button>{link && <div className="copy-link"><input readOnly value={link} /><button onClick={() => navigator.clipboard.writeText(link)}><Copy /></button><small>This one-time link creates a new identity. Send it only to the intended person.</small></div>}</div> : <p className="notice">Only the document owner can create invitation links.</p>}
    <section className="people-list"><h3>People</h3>{snapshot.participants.map((person, index) => <div key={person.id}><span style={{ background: colors[index % colors.length] }}>{initials(person.displayName)}</span><p><strong>{person.displayName}{person.id === snapshot.participant.id ? " (you)" : ""}</strong><small>{person.role}</small></p>{snapshot.participant.role === "owner" && person.id !== snapshot.participant.id && <button className="revoke" onClick={() => revoke(person.id)}>Revoke</button>}</div>)}</section>
    <div className="account-actions"><button onClick={changeName}>Change my display name</button><button onClick={rotateLink}>Rotate my private return link</button><button className="danger-link" onClick={forget}>Forget this document on this device</button></div>
  </div>;
}

interface PanelProps { documentId: string; token: string; snapshot: DocumentSnapshot; setSnapshot: (value: DocumentSnapshot) => void; setError: (value: string) => void }

function PanelHeader({ panel, setPanel, counts }: { panel: PanelName; setPanel: (panel: PanelName | null) => void; counts: { pending: number; unresolved: number } }) {
  const items: Array<{ id: PanelName; label: string; icon: typeof Sparkles; count?: number }> = [{ id: "ai", label: "AI", icon: Sparkles, count: counts.pending }, { id: "comments", label: "Comments", icon: MessageCircle, count: counts.unresolved }, { id: "history", label: "History", icon: History }, { id: "share", label: "Share", icon: Users }];
  return <><div className="panel-top"><div className="panel-tabs">{items.map((item) => <button className={panel === item.id ? "active" : ""} key={item.id} onClick={() => setPanel(item.id)} title={item.label}><item.icon />{item.count ? <b>{item.count}</b> : null}</button>)}</div><button className="icon-button" onClick={() => setPanel(null)} aria-label="Close panel"><X /></button></div></>;
}

function AvatarStack({ participants }: { participants: DocumentSnapshot["participants"] }) { return <div className="avatar-stack" title={`${participants.length} collaborator${participants.length === 1 ? "" : "s"}`}>{participants.slice(0, 4).map((person, index) => <span key={person.id} style={{ background: colors[index % colors.length] }}>{initials(person.displayName)}</span>)}</div>; }
function SaveState({ status }: { status: string }) { const offline = status === "reconnecting" || status === "revoked"; return <span className={`save-state ${offline ? "offline" : ""}`}>{offline ? <CloudOff /> : status === "saved" ? <Check /> : <Cloud />}{status === "saved" ? "Saved" : status === "saving" ? "Saving…" : status === "revoked" ? "Access ended" : "Reconnecting…"}</span>; }
function StatusPill({ status }: { status: string }) { return <span className={`status-pill ${status}`}>{status}</span>; }
function EmptyState({ icon: Icon, title, text }: { icon: typeof History; title: string; text: string }) { return <div className="empty-state"><Icon /><strong>{title}</strong><p>{text}</p></div>; }
function Brand() { return <a href="/" className="brand"><Logo /><span>Draft</span></a>; }
function Logo() { return <span className="logo"><Sparkles /></span>; }
function LoadingPage() { return <main className="loading-page"><Logo /><span /><p>Opening your shared draft…</p></main>; }
function ErrorPage({ message }: { message: string }) { return <main className="center-page"><div className="error-card"><Logo /><h1>We couldn’t open this document</h1><p>{message}</p><a className="primary" href="/">Back to Draft</a></div></main>; }
function AccessMissing({ documentId }: { documentId: string }) { return <main className="center-page"><div className="error-card"><Logo /><h1>Private link required</h1><p>This document ID does not grant access. Open your private return link or ask the owner for an invitation.</p><button className="danger-link" onClick={() => { forgetDocument(documentId); location.href = "/"; }}>Back to Draft</button></div></main>; }

function parseRoute(): { kind: "home" } | { kind: "document" | "join"; documentId: string; token: string } {
  const match = location.pathname.match(/^\/(doc|join)\/([0-9a-f-]{36})$/i);
  if (!match) return { kind: "home" };
  const params = new URLSearchParams(location.hash.slice(1));
  return { kind: match[1] === "doc" ? "document" : "join", documentId: match[2], token: params.get(match[1] === "doc" ? "access" : "invite") ?? "" };
}

function initials(name: string): string { return name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase()).join(""); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
function article(role: ParticipantRole): string { return role === "editor" ? "an" : "a"; }
function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document"; }
