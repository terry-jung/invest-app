"use client";

import { useEffect, useState } from "react";

type Redemption = { user_id: string; email: string | null; kind: string; redeemed_at: string };
type Invite = {
  code: string;
  note: string | null;
  created_at: string;
  max_uses: number;
  uses: number;
  redemptions: Redemption[];
};

export default function AdminPage() {
  const [pass, setPass] = useState("");
  const [authed, setAuthed] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  // Restore passphrase from sessionStorage so a refresh doesn't kick you
  // out mid-session. sessionStorage scopes to the tab — closing it clears.
  useEffect(() => {
    const saved = sessionStorage.getItem("admin_pass");
    if (saved) { setPass(saved); void load(saved); }
  }, []);

  async function load(p: string) {
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/admin/invites", { headers: { "x-owner-passphrase": p } });
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites || []);
        setAuthed(true);
        sessionStorage.setItem("admin_pass", p);
      } else if (res.status === 403) {
        setErr("Wrong passphrase.");
        setAuthed(false);
        sessionStorage.removeItem("admin_pass");
      } else {
        setErr(`Failed (${res.status}).`);
      }
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function createInvite() {
    setBusy(true); setErr(""); setJustCreated(null);
    try {
      const cap = Math.max(1, Math.min(1000, parseInt(maxUses, 10) || 1));
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-owner-passphrase": pass,
        },
        body: JSON.stringify({ note: note.trim() || null, maxUses: cap }),
      });
      if (res.ok) {
        const data = await res.json();
        setJustCreated(data.invite.code);
        setNote("");
        await load(pass);
      } else {
        setErr(`Failed (${res.status}).`);
      }
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <div style={{ maxWidth: 420, margin: "120px auto", padding: 24, fontFamily: "var(--font-sans)" }}>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>Admin</h1>
        <p style={{ color: "#666", fontSize: 14, marginBottom: 16 }}>
          Enter the OWNER_PASSPHRASE to manage invite codes.
        </p>
        <input
          type="password"
          autoFocus
          value={pass}
          onChange={(e) => { setPass(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) void load(pass); }}
          placeholder="passphrase"
          style={{ width: "100%", padding: "10px 12px", border: "1px solid #ccc", borderRadius: 6, fontSize: 14 }}
          disabled={busy}
        />
        {err && <div style={{ color: "#b00", fontSize: 13, marginTop: 8 }}>{err}</div>}
        <button
          onClick={() => void load(pass)}
          disabled={busy || !pass}
          style={{ marginTop: 12, padding: "10px 20px", background: "#111", color: "#fff", border: 0, borderRadius: 6, fontSize: 14, cursor: "pointer", opacity: busy || !pass ? 0.5 : 1 }}
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 24, fontFamily: "var(--font-sans)" }}>
      <h1 style={{ fontSize: 28, marginBottom: 24 }}>Invite codes</h1>

      <section style={{ background: "#f6f6f6", padding: 16, borderRadius: 8, marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Generate new code</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. 'for Jane')"
            style={{ flex: 1, padding: "8px 10px", border: "1px solid #ccc", borderRadius: 6, fontSize: 14 }}
            disabled={busy}
          />
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            title="Max uses (1 = single-use)"
            style={{ width: 90, padding: "8px 10px", border: "1px solid #ccc", borderRadius: 6, fontSize: 14, textAlign: "center" }}
            disabled={busy}
          />
        </div>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>Max uses — how many people can redeem this one code (signups + resets combined)</div>
        <button
          onClick={() => void createInvite()}
          disabled={busy}
          style={{ padding: "8px 16px", background: "#111", color: "#fff", border: 0, borderRadius: 6, fontSize: 14, cursor: "pointer", opacity: busy ? 0.5 : 1 }}
        >
          {busy ? "Working…" : "Generate"}
        </button>
        {justCreated && (
          <div style={{ marginTop: 12, padding: 12, background: "#fff", border: "1px solid #0a0", borderRadius: 6 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>New invite code:</div>
            <code style={{ fontSize: 18, fontWeight: 600, letterSpacing: 1 }}>{justCreated}</code>
          </div>
        )}
        {err && <div style={{ color: "#b00", fontSize: 13, marginTop: 8 }}>{err}</div>}
      </section>

      <h2 style={{ fontSize: 16, marginBottom: 12 }}>All codes ({invites.length})</h2>
      {invites.length === 0 ? (
        <div style={{ color: "#666", fontSize: 14 }}>No codes yet. Generate one above.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {invites.map((inv) => {
            const exhausted = inv.uses >= inv.max_uses;
            return (
              <div key={inv.code} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, background: "#fff" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                  <code style={{ fontSize: 14, fontWeight: 600 }}>{inv.code}</code>
                  <span style={{ fontSize: 12, color: exhausted ? "#888" : "#0a0", fontWeight: 600 }}>
                    {inv.uses} / {inv.max_uses} {exhausted ? "(used up)" : "used"}
                  </span>
                  {inv.note && <span style={{ fontSize: 12, color: "#666" }}>{inv.note}</span>}
                  <span style={{ fontSize: 11, color: "#aaa", marginLeft: "auto" }}>{inv.created_at.slice(0, 10)}</span>
                </div>
                {inv.redemptions.length > 0 && (
                  <ul style={{ marginTop: 8, paddingLeft: 16, fontSize: 12, color: "#666" }}>
                    {inv.redemptions.map((r) => (
                      <li key={`${r.user_id}-${r.redeemed_at}`}>
                        {r.kind === "reset" ? "Reset" : "Signup"} by {r.email ?? "?"} · {r.redeemed_at.slice(0, 10)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
