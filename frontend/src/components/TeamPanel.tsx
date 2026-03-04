import { useState, useEffect, useCallback } from "react";
import styles from "./TeamPanel.module.css";

interface TeamMember {
  userId: string;
  email: string;
  name: string;
  canInvite: boolean;
  imageUrl?: string;
}

interface TeamInfo {
  configured: boolean;
  role: string;
  team?: TeamMember[];
  adminName?: string;
  deviceName?: string;
  canInvite?: boolean;
}

interface Props {
  role: "admin" | "member";
  canInvite: boolean;
  onShowInvite: () => void;
}

export function TeamPanel({ role, canInvite, onShowInvite }: Props) {
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchTeamInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/team/info");
      if (!res.ok) return;
      const data = await res.json();
      setTeamInfo(data);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchTeamInfo();
  }, [fetchTeamInfo]);

  async function removeMember(userId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/team/members/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove");
      }
      fetchTeamInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    }
  }

  async function toggleCanInvite(userId: string, current: boolean) {
    setError(null);
    try {
      const res = await fetch(`/api/team/members/${userId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canInvite: !current }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update");
      }
      fetchTeamInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function leaveTeam() {
    if (!confirm("Leave this team? You'll lose access to the device.")) return;
    setError(null);
    try {
      const res = await fetch("/api/team/leave", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to leave");
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Leave failed");
    }
  }

  if (!teamInfo) return null;

  // Member view
  if (role === "member") {
    const memberTeam = teamInfo.team || [];
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.label}>Team</span>
          {canInvite && (
            <button className={styles.inviteButton} onClick={onShowInvite}>
              + Invite
            </button>
          )}
        </div>

        {memberTeam.length > 0 && (
          <div className={styles.memberList}>
            {memberTeam.map((member) => (
              <div key={member.userId} className={styles.memberRow}>
                {member.imageUrl ? (
                  <img src={member.imageUrl} alt="" className={styles.avatar} />
                ) : (
                  <div className={styles.avatarPlaceholder}>
                    {(member.name || member.email || "?")[0].toUpperCase()}
                  </div>
                )}
                <div className={styles.memberInfo}>
                  <span className={styles.memberName}>{member.name}</span>
                  <span className={styles.memberEmail}>{member.email}</span>
                </div>
                {(member as TeamMember & { role?: string }).role === "admin" && (
                  <span className={styles.memberBadge}>Admin</span>
                )}
              </div>
            ))}
          </div>
        )}

        <button className={styles.leaveButton} onClick={leaveTeam}>
          Leave Team
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    );
  }

  // Admin view
  const team = teamInfo.team || [];

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.label}>Team</span>
        {canInvite && (
          <button className={styles.inviteButton} onClick={onShowInvite}>
            + Invite
          </button>
        )}
      </div>

      {team.length === 0 ? (
        <p className={styles.empty}>No team members yet</p>
      ) : (
        <div className={styles.memberList}>
          {team.map((member) => (
            <div key={member.userId} className={styles.memberRow}>
              {member.imageUrl ? (
                <img src={member.imageUrl} alt="" className={styles.avatar} />
              ) : (
                <div className={styles.avatarPlaceholder}>
                  {(member.name || member.email || "?")[0].toUpperCase()}
                </div>
              )}
              <div className={styles.memberInfo}>
                <span className={styles.memberName}>{member.name}</span>
                <span className={styles.memberEmail}>{member.email}</span>
              </div>
              {member.canInvite && (
                <span className={styles.memberBadge}>Can invite</span>
              )}
              <div className={styles.memberActions}>
                <button
                  className={styles.actionButton}
                  onClick={() => toggleCanInvite(member.userId, member.canInvite)}
                  title={member.canInvite ? "Revoke invite permission" : "Allow inviting"}
                >
                  {member.canInvite ? "🔓" : "🔒"}
                </button>
                <button
                  className={`${styles.actionButton} ${styles.removeButton}`}
                  onClick={() => removeMember(member.userId)}
                  title="Remove member"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
