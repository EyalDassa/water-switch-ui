import { useState } from "react";
import styles from "./InviteModal.module.css";

interface Props {
  onClose: () => void;
}

export function InviteModal({ onClose }: Props) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/team/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send invite");
      setSuccess(`Invite sent to ${email.trim()}`);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error sending invite");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.title}>Invite Member</h2>
          <button className={styles.closeButton} onClick={onClose}>✕</button>
        </div>

        <div className={styles.content}>
          <form className={styles.section} onSubmit={sendInvite}>
            <div className={styles.emailRow}>
              <input
                type="email"
                className={styles.emailInput}
                placeholder="Enter email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                autoFocus
              />
              <button
                type="submit"
                className={styles.sendButton}
                disabled={loading || !email.trim()}
              >
                {loading ? "..." : "Invite"}
              </button>
            </div>
            {success && <p className={styles.success}>{success}</p>}
          </form>

          {error && <p className={styles.error}>{error}</p>}
        </div>
      </div>
    </div>
  );
}
