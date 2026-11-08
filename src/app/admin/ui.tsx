"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
type Row = Record<string, any>;
const money = (n: number) => `PKR ${Number(n || 0).toLocaleString("en-PK")}`;
const date = (v: string) => v ? new Date(v).toLocaleString("en-PK", { timeZone: "Asia/Karachi" }) : "Not set";
export function AdminClient({ authenticated, businesses, plans, payments, role = "viewer" }: { authenticated: boolean; businesses: Row[]; plans: Row[]; payments: Row[]; role?: string }) {
  const router = useRouter();
  const registrationForm = useRef<HTMLFormElement>(null);
  const managementSection = useRef<HTMLElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const submit = (handler: (form: FormData) => Promise<void>) => (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void handler(new FormData(event.currentTarget)); };
  const [message, setMessage] = useState(""); const [code, setCode] = useState(""); const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("provision"); const [selected, setSelected] = useState<Row | null>(null);
  const [details, setDetails] = useState<Row | null>(null); const [action, setAction] = useState("support"); const [target, setTarget] = useState("basic");
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [backupView, setBackupView] = useState<Row | null>(null);
  const [planEdit, setPlanEdit] = useState("basic"); const ids = useRef<Record<string, string>>({});
  useEffect(() => { if (deleting) deleteDialog.current?.showModal(); }, [deleting]);
  const canEdit = role !== "viewer";
  const editingPlan = plans.find(p => p.key === planEdit);
  async function request(url: string, method: string, body?: unknown) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || "Request failed");
      if (result.data?.activationCode) setCode(result.data.activationCode);
      if (method !== "GET") { setMessage("Saved successfully"); router.refresh(); }
      return result.data;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed"); return null; }
    finally { setBusy(false); }
  }
  function planTarget(b: Row) { return plans.find(p => p.active !== false && p.key !== b.planKey)?.key || b.planKey; }
  async function showBusiness(b: Row, nextAction = "support") {
    setBackupView(null);
    setSelected(b); setDetails(null); setAction(nextAction); setTarget(planTarget(b));
    const data = await request(`/api/v1/admin/businesses/${b._id}`, "GET");
    if (data) { setDetails(data); setSelected(data.business); setTarget(planTarget(data.business)); }
    managementSection.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function removeBusiness(form: FormData) {
    if (!deleting) return;
    const saved = await request(`/api/v1/admin/businesses/${deleting._id}`, "DELETE", Object.fromEntries(form));
    if (saved) {
      setDeletedIds(previous => [...previous, deleting._id]);
      if (selected?._id === deleting._id) { setSelected(null); setDetails(null); }
      setBackupView(null); setCode(""); setDeleting(null); setMessage(`Deleted ${deleting.name}. Payment and audit history retained.`);
    }
  }
  async function login(form: FormData) { const saved = await request("/api/v1/admin/session", "POST", Object.fromEntries(form)); if (saved) location.reload(); }
  async function register(form: FormData) {
    const f = Object.fromEntries(form);
    const saved = await request("/api/v1/admin/businesses", "POST", { contractVersion: 2, name: f.name, region: f.region, externalReference: f.externalReference,
      planKey: f.planKey, provisioningMode: mode, expiryPolicy: f.expiryPolicy, agreementNotes: f.agreementNotes,
      ...(mode === "enroll" ? { supportExpiresAt: f.supportExpiresAt ? new Date(`${f.supportExpiresAt}T23:59:59+05:00`).toISOString() : null } : {}),
      ...(mode === "provision" ? { owner: { username: f.username, firstname: f.firstname, lastname: f.lastname, email: f.email,
        mobileno: String(f.mobileno).split(",").map(v => v.trim()).filter(Boolean), password: f.password } } : {}) });
    if (saved) { setMessage(`Registered ${saved.business.name}. Copy the activation code below; it expires in seven days.`); registrationForm.current?.reset(); setMode("provision"); }
  }
  async function savePlan(form: FormData) {
    const f = Object.fromEntries(form);
    await request("/api/v1/admin/plans", "PUT", { key: planEdit, name: f.name, installationPrice: Number(f.installationPrice), annualPrice: Number(f.annualPrice),
      monthlyPrice: 0, userLimit: Number(f.userLimit), features: String(f.features || "").split(",").map(v => v.trim()).filter(Boolean), addOns: [] });
  }
  const targetPlan = plans.find(p => p.key === target);
  const isDowngrade = selected && ["basic", "premium", "enterprise"].indexOf(target) < ["basic", "premium", "enterprise"].indexOf(selected.planKey);
  const charge = selected ? action === "installation" ? (selected.initialInstallationPrice ?? selected.installationPrice) : action === "support" ? selected.annualSupportPrice : isDowngrade ? 0 : Math.max(0, (targetPlan?.installationPrice || 0) - selected.installationPrice) : 0;
  async function manage(form: FormData) {
    if (!selected) return;
    const f = Object.fromEntries(form); const idKey = `${selected._id}:${action}`;
    ids.current[idKey] ||= crypto.randomUUID();
    const body = { requestId: ids.current[idKey], amount: Number(f.amount), discount: Number(f.discount || 0), method: f.method,
      reference: f.reference, reason: f.reason, paidAt: f.paidAt ? new Date(`${f.paidAt}T12:00:00+05:00`).toISOString() : new Date().toISOString(), terms: Number(f.terms || 1), planKey: target, purpose: "installation" };
    const path = action === "support" ? "renew" : action === "plan" ? "plan" : "payments";
    const saved = await request(`/api/v1/admin/businesses/${selected._id}/${path}`, "POST", body);
    if (saved) { delete ids.current[idKey]; const refreshed = await request(`/api/v1/admin/businesses/${selected._id}`, "GET"); setDetails(refreshed); setSelected(refreshed?.business || selected); setAction("support"); setTarget(planTarget(refreshed?.business || selected)); }
  }
  async function adjust(form: FormData) {
    if (!selected) return; const f = Object.fromEntries(form);
    const saved = await request(`/api/v1/admin/businesses/${selected._id}`, "PATCH", { contractVersion: 2, name: f.name, region: f.region, expiryPolicy: f.expiryPolicy,
      supportExpiresAt: f.supportExpiresAt ? new Date(`${f.supportExpiresAt}T23:59:59+05:00`).toISOString() : null, reason: f.reason });
    if (saved) { setSelected(saved); await showBusiness(saved); }
  }
  async function saveBackup(form: FormData) {
    if (!selected) return;
    const saved = await request(`/api/v1/admin/businesses/${selected._id}/backup`, 'PUT', {
      enabled: form.get('enabled') === 'on', database: form.get('database'), uri: form.get('uri') || undefined, reason: form.get('reason')
    });
    if (saved) { await showBusiness(selected); setMessage("Backup destination saved. The ERP uses it on its next backup."); }
  }
  async function revealBackup() {
    if (!selected) return;
    if (backupView?.businessId === selected._id) { setBackupView(null); return; }
    const saved = await request(`/api/v1/admin/businesses/${selected._id}/backup`, 'GET');
    if (saved) setBackupView({ businessId: selected._id, ...saved });
  }
  async function reasonAction(b: Row, kind: string) {
    const reason = prompt(kind === "transfer" ? "Transfer revokes the old installation. Restore its database on the destination, then enroll with the new code. Enter a reason:" : "Reason for this change:");
    if (!reason) return;
    const path = `/api/v1/admin/businesses/${b._id}`;
    const saved = await request(kind === "suspend" || kind === "reactivate" ? path : `${path}/${kind}`, kind === "suspend" || kind === "reactivate" ? "PATCH" : "POST",
      { reason, ...(kind === "suspend" || kind === "reactivate" ? { configuredStatus: kind === "suspend" ? "suspended" : "active" } : {}), ...(kind === "transfer" ? { mode: "enroll" } : {}) });
    if (saved && selected?._id === b._id) await showBusiness(saved.business || b);
  }
  if (!authenticated) return <main className="shell"><section className="card" style={{ maxWidth: 420, margin: "80px auto" }}><h1>Synexus administrator login</h1><form onSubmit={submit(login)} className="stack"><input name="email" type="email" placeholder="Email" required/><input name="password" type="password" placeholder="Password" required/><input name="totp" inputMode="numeric" placeholder="6-digit authenticator code" required/><button disabled={busy}>Sign in</button>{message && <p role="alert">{message}</p>}</form></section></main>;
  return <main className="shell">
    <div className="bar"><div><div className="brand">Synexus / PANDAS</div><p className="muted">Client activation, software plans and annual support</p></div><button onClick={async () => { await fetch("/api/v1/admin/session", { method: "DELETE" }); location.reload(); }}>Sign out</button></div>
    {message && <p className="notice" role="status">{message}</p>}
    {code && <section className="card"><strong>Activation code</strong><p style={{ overflowWrap: "anywhere", fontSize: 22 }}>{code}</p><button onClick={() => navigator.clipboard.writeText(code)}>Copy code</button><p className="muted">Single use | expires after seven days | shown only when issued</p></section>}
    <div className="grid cols" style={{ marginTop: 16 }}>{plans.map(p => <section className="card" key={p.key}><h2>{p.name}</h2><p>{money(p.installationPrice)} installation</p><p>{money(p.annualPrice)} annual renewal | {p.userLimit} active users</p><small>First support year included</small></section>)}</div>
    {canEdit && <div className="grid cols" style={{ marginTop: 16 }}><section className="card"><h2>Register client business</h2><form ref={registrationForm} data-testid="client-registration" onSubmit={submit(register)} className="stack">
      <select aria-label="Setup type" value={mode} onChange={e => setMode(e.target.value)}><option value="provision">New business: provision owner and defaults</option><option value="enroll">Existing business: enroll without reseeding</option></select>
      <input name="name" placeholder="Business name" required/><input name="region" placeholder="Business region / city" required/><input name="externalReference" placeholder="Internal client reference"/>
      <select name="planKey" aria-label="Plan">{plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select>
      <select name="expiryPolicy" aria-label="Support expiry policy" required defaultValue=""><option value="" disabled>Choose support-expiry policy</option><option value="keep_working">Continue ERP use after support expires</option><option value="read_only">Read-only after support expires</option></select>
      {mode === "provision" ? <><input name="username" autoComplete="off" placeholder="Owner username" required/><input name="firstname" placeholder="Owner first name" required/><input name="lastname" placeholder="Owner last name"/><input name="email" type="email" placeholder="Owner email (optional)"/><input name="mobileno" placeholder="Owner mobile numbers, comma separated" required/><input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" placeholder="Initial owner password (12+ characters)" required/></> : <label>Reviewed support end date (leave blank if no current coverage)<input name="supportExpiresAt" type="date"/></label>}
      <textarea name="agreementNotes" placeholder="Agreement notes"/><button disabled={busy}>Register and generate code</button>
    </form></section><section className="card"><h2>Plan catalog</h2><select value={planEdit} onChange={e => setPlanEdit(e.target.value)}>{plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select>
      {editingPlan && <form onSubmit={submit(savePlan)} className="stack" key={planEdit}><label>Display name<input name="name" defaultValue={editingPlan.name} required/></label><label>Installation PKR<input name="installationPrice" type="number" min="0" defaultValue={editingPlan.installationPrice} required/></label><label>Annual renewal PKR<input name="annualPrice" type="number" min="0" defaultValue={editingPlan.annualPrice} required/></label><label>Active-user limit<input name="userLimit" type="number" min="1" defaultValue={editingPlan.userLimit} required/></label><label>Feature keys (blank uses included plan features)<input name="features" defaultValue={editingPlan.features?.join(", ")}/></label><button disabled={busy}>Save catalog</button><small>Recorded payments and existing contractual price snapshots are preserved.</small></form>}
    </section></div>}
    <section className="card" style={{ marginTop: 16, overflowX: "auto" }}><h2>Client businesses</h2><table><thead><tr><th>Business</th><th>Plan</th><th>ERP access policy</th><th>Support through</th><th>Actions</th></tr></thead><tbody>{businesses.filter(b => !deletedIds.includes(b._id)).map(b => <tr key={b._id} data-business-id={b._id}><td>{b.name}<div className="muted">{b.externalReference}</div></td><td>{b.planKey}{b.requestedPlan && <div>Requested: {b.requestedPlan.planKey}</div>}</td><td>{b.contractVersion !== 2 ? "Agreement needs review" : b.configuredStatus === "suspended" ? "Suspended" : b.expiryPolicy === "read_only" ? "Read-only after support expiry" : "Continues without support"}</td><td>{date(b.supportExpiresAt)}</td><td><button disabled={busy} onClick={() => showBusiness(b)}>Manage</button>{canEdit && <><button disabled={busy || b.contractVersion !== 2} title={b.contractVersion !== 2 ? "Review the agreement in Manage before changing plans" : undefined} onClick={() => showBusiness(b, "plan")}>Change plan</button><button disabled={busy} onClick={() => reasonAction(b, "activation-code")}>New code</button><button disabled={busy} onClick={() => reasonAction(b, b.configuredStatus === "suspended" ? "reactivate" : "suspend")}>{b.configuredStatus === "suspended" ? "Reactivate" : "Suspend"}</button>{role === "owner" && <><button disabled={busy} onClick={() => reasonAction(b, "transfer")}>Transfer</button><button className="danger" disabled={busy} onClick={() => { setMessage(""); setDeleting(b); }}>Delete</button></>}</>}</td></tr>)}</tbody></table></section>
    {deleting && <dialog ref={deleteDialog} className="card delete-dialog" aria-labelledby="delete-title" onCancel={event => { event.preventDefault(); if (!busy) setDeleting(null); }}><h2 id="delete-title">Delete {deleting.name}?</h2><p>This removes the business from the active list and revokes its installation and activation codes. Payment and audit history will be retained.</p><p className="muted">The ERP receives the suspension when it reconnects. Offline access follows its existing cached license.</p><form className="stack" data-testid="delete-business" key={deleting._id} onSubmit={submit(removeBusiness)}><label>Type the business name exactly to confirm<input name="confirmName" autoFocus autoComplete="off" required/></label><label>Deletion reason<input name="reason" minLength={3} maxLength={2000} required/></label>{message && <p role="alert">{message}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button><button className="danger" disabled={busy}>Delete business</button></div></form></dialog>}
    {selected && <section ref={managementSection} className="card" style={{ marginTop: 16 }}><div className="bar"><h2>{selected.name}</h2><button disabled={busy} onClick={() => { setSelected(null); setDetails(null); setBackupView(null); }}>Close</button></div>
      {details?.installations?.map((i: Row) => <div className="notice" key={i._id}><strong>{i.label} | {i.status}</strong><p>Last contact: {date(i.lastSeenAt)} | ERP {i.telemetry?.erpVersion || "unknown"}</p><p>{i.telemetry?.activeUserCount ?? "Unknown"} active users | applied revision {i.telemetry?.appliedRevision ?? "unknown"} / requested revision {selected.revision}</p><p>{!i.lastSeenAt || Date.now() - new Date(i.lastSeenAt).getTime() > 120000 ? "Awaiting reconnection" : i.telemetry?.syncResult || "Awaiting synchronization"}</p>{i.telemetry?.lastError && <p>Last reported issue: {i.telemetry.lastError}</p>}<small>Deployment {i.deploymentId} | Local business {i.localBusinessId}</small></div>)}
      {canEdit && <div className="grid cols"><section><h3>{selected.contractVersion === 2 ? "Agreement adjustment" : "Review and migrate existing agreement"}</h3><form className="stack" onSubmit={submit(adjust)} key={selected._id}><input name="name" defaultValue={selected.name} placeholder="Business name (must match existing ERP for enrollment)" required/><input name="region" defaultValue={selected.region} placeholder="Business region" required/><select name="expiryPolicy" defaultValue={selected.expiryPolicy || ""} required><option value="" disabled>Select expiry policy</option><option value="keep_working">Continue without support</option><option value="read_only">Read-only when support expires</option></select><label>Reviewed support end date<input name="supportExpiresAt" type="date" defaultValue={selected.supportExpiresAt ? new Date(selected.supportExpiresAt).toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }) : ""}/></label><input name="reason" placeholder="Adjustment reason" required minLength={3}/><button disabled={busy}>Save reviewed agreement</button></form></section>
      {selected.contractVersion === 2 && <section><h3>{action === "plan" ? "Change plan" : "Record payment / change plan"}</h3><form data-testid="contract-payment" onSubmit={submit(manage)} className="stack" key={`${selected._id}:${action}:${target}`}><select aria-label="Management action" value={action} onChange={e => setAction(e.target.value)}><option value="support">Renew support (one year)</option><option value="installation">Record installation payment</option><option value="plan">Upgrade or downgrade</option></select>{action === "plan" && <><label>New plan<select aria-label="New plan" value={target} onChange={e => setTarget(e.target.value)}>{plans.filter(p => p.active !== false && p.key !== selected.planKey).map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select></label>{selected.requestedPlan && <p role="status">A downgrade is pending. Cancel it before requesting another plan change.</p>}</>}<p>Expected charge: {money(charge)}</p><label>Received PKR<input name="amount" type="number" step="0.01" min="0" defaultValue={charge} required/></label><label>Discount / waiver PKR<input name="discount" type="number" step="0.01" min="0" defaultValue="0"/></label><select name="method"><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="other">Other</option><option value="waiver">Waiver</option></select><input name="reference" placeholder="Receipt / bank reference"/><label>Payment date (today if blank)<input name="paidAt" type="date"/></label><input name="reason" placeholder="Reason, including discount or waiver details" minLength={3} required/><button disabled={busy || (action === "plan" && (!!selected.requestedPlan || !targetPlan || target === selected.planKey))}>{action === "plan" ? "Apply plan change" : "Record and apply"}</button><small>Support renewal preserves suspension. Downgrades wait for staff reduction; support end dates stay unchanged.</small></form>
      {selected.requestedPlan && <button disabled={busy} onClick={async () => { const reason = prompt("Reason for cancelling the pending downgrade:"); if (reason) { const result = await request(`/api/v1/admin/businesses/${selected._id}/plan`, "DELETE", { reason }); if (result) await showBusiness(result); } }}>Cancel pending downgrade</button>}</section>}</div>}
      {canEdit && selected.provisioningMode === "provision" && !details?.installations?.some((i: Row) => i.provisioningCompleteAt) && <button disabled={busy} onClick={async () => {
        const username = prompt("Correct the pending owner's username (for example, if it conflicts with another local business):"); if (!username) return;
        const reason = prompt("Reason for correcting the bootstrap profile:"); if (!reason) return;
        await request(`/api/v1/admin/businesses/${selected._id}/bootstrap`, "PATCH", { username, reason });
      }}>Correct pending owner username</button>}
      {role === 'owner' && <section><h3>Client backup destination</h3><p>Premium: once every seven days. Enterprise: once every 24 hours. Use a separate Atlas cluster for each client; only its latest successful backup is retained.</p><p className="muted">{selected.backupHost ? `Configured cluster: ${selected.backupHost}` : 'No Atlas connection configured'}</p><p className="muted">Saved database: {selected.backupDatabase || 'Not configured'}</p><button type="button" disabled={busy || !selected.backupHost} onClick={revealBackup}>{backupView?.businessId === selected._id ? 'Hide Atlas URI' : 'View saved Atlas URI'}</button>{backupView && backupView.businessId === selected._id && <div className="stack" data-testid="backup-credentials" style={{ margin: '12px 0' }}><label>Saved Atlas URI<textarea aria-label="Saved Atlas URI" readOnly value={backupView.uri} rows={3} style={{ overflowWrap: 'anywhere' }}/></label><label>Saved database name<input aria-label="Saved database name" readOnly value={backupView.database}/></label></div>}<form className="stack" data-testid="backup-destination" key={`backup:${selected._id}:${selected.updatedAt}`} onSubmit={submit(saveBackup)}><label style={{ display: "flex", alignItems: "center", gap: 8 }}><input style={{ width: "auto" }} name="enabled" type="checkbox" defaultChecked={selected.backupEnabled}/>Enable this client’s backups</label><label>MongoDB SRV connection<input name="uri" type="password" autoComplete="new-password" placeholder="mongodb+srv://username:password@client-cluster.mongodb.net/"/><small>Leave blank to keep the saved connection. Credentials are encrypted and never shown in the ERP browser.</small></label><label>Database name<input name="database" defaultValue={selected.backupDatabase || ''} pattern="[a-zA-Z0-9_-]{1,63}" required/></label><label>Reason<input name="reason" minLength={3} required/></label><button disabled={busy}>Save backup destination</button></form></section>}
      <h3>Manual payments</h3><div style={{ overflowX: "auto" }}><table><thead><tr><th>Date</th><th>Purpose</th><th>Paid</th><th>Discount</th><th>Method / reference</th></tr></thead><tbody>{details?.payments?.map((p: Row) => <tr key={p._id}><td>{date(p.paidAt)}</td><td>{p.purpose}</td><td>{money(p.amount)}</td><td>{money(p.discount)}</td><td>{p.method} {p.reference}</td></tr>)}</tbody></table></div>
      <h3>Audit history</h3>{details?.events?.map((e: Row) => <p key={e._id}><small>{date(e.createdAt)}</small> | {e.type} | {e.reason}</p>)}
    </section>}
    {payments.length > 0 && <section className="card" style={{ marginTop: 16, overflowX: "auto" }}><h2>Historical online orders</h2><p>Online payment processing is disabled. Existing order records are retained.</p><table><tbody>{payments.map(p => <tr key={p._id}><td>{p.orderId}</td><td>{p.status}</td><td>{money(p.amount)}</td></tr>)}</tbody></table></section>}
  </main>;
}
