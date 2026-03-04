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
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [nameSaving, setNameSaving] = useState(false);

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
    if (!confirm("Leave this household? You'll lose access to the device.")) return;
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

  async function saveDeviceName() {
    if (!nameInput.trim()) return;
    setNameSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/team/device-name", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceName: nameInput.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update name");
      }
      setEditingName(false);
      fetchTeamInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setNameSaving(false);
    }
  }

  if (!teamInfo) return null;

  const displayName = teamInfo.deviceName || "Household";

  // Member view
  if (role === "member") {
    const memberTeam = teamInfo.team || [];
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.label}>{displayName}</span>
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
          Leave Household
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
        {editingName ? (
          <div className={styles.nameEdit}>
            <input
              className={styles.nameInput}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveDeviceName();
                if (e.key === "Escape") setEditingName(false);
              }}
              disabled={nameSaving}
              autoFocus
              maxLength={50}
            />
            <button
              className={styles.nameConfirm}
              onClick={saveDeviceName}
              disabled={nameSaving || !nameInput.trim()}
            >
              {nameSaving ? "..." : "Save"}
            </button>
            <button
              className={styles.nameCancel}
              onClick={() => setEditingName(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <span
            className={`${styles.label} ${styles.labelEditable}`}
            onClick={() => {
              setNameInput(teamInfo.deviceName || "");
              setEditingName(true);
            }}
            title="Click to rename"
          >
            {displayName}
            <span className={styles.editIcon}>&#9998;</span>
          </span>
        )}
        {!editingName && canInvite && (
          <button className={styles.inviteButton} onClick={onShowInvite}>
            + Invite
          </button>
        )}
      </div>

      {team.length === 0 ? (
        <p className={styles.empty}>No members yet</p>
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
                  {member.canInvite ? "\uD83D\uDD13" : "\uD83D\uDD12"}
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
