import { Router } from "express";
import { getAuth } from "@clerk/express";
import { createClerkClient } from "@clerk/express";

const router = Router();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ── In-memory email invite store ──────────────────────────────────────────────
// email (lowercase) → { adminUserId, deviceId, homeId, deviceName }
const emailInvites = new Map();

// Track which admins have had their invites loaded from metadata
const loadedAdmins = new Set();

/** Lazily restore email invites from admin's privateMetadata after server restart */
async function ensureInvitesLoaded(adminUserId) {
  if (loadedAdmins.has(adminUserId)) return;
  loadedAdmins.add(adminUserId);

  try {
    const user = await clerk.users.getUser(adminUserId);
    const priv = user.privateMetadata || {};
    const pub = user.publicMetadata || {};

    const deviceInfo = {
      adminUserId,
      deviceId: pub.deviceId,
      homeId: pub.homeId,
      deviceName: pub.deviceName,
    };

    for (const ei of priv.pendingEmailInvites || []) {
      emailInvites.set(ei.email.toLowerCase(), deviceInfo);
    }
  } catch (err) {
    console.error(`[team] Failed to load invites for admin ${adminUserId}:`, err.message);
  }
}

/** Fetch user's publicMetadata from Clerk API (session claims don't include it) */
async function getUserPub(userId) {
  const user = await clerk.users.getUser(userId);
  return user.publicMetadata || {};
}

/** Check if user can manage invites (admin or canInvite member) */
function canInvite(pub) {
  const role = pub?.role || (pub?.configured ? "admin" : null);
  if (role === "admin") return true;
  if (role === "member" && pub?.canInvite) return true;
  return false;
}

function isAdmin(pub) {
  const role = pub?.role || (pub?.configured ? "admin" : null);
  return role === "admin";
}

/** Get the admin userId (self if admin, or adminUserId if member) */
function getAdminUserId(pub, userId) {
  if (isAdmin(pub)) return userId;
  return pub?.adminUserId || null;
}

// ── POST /api/team/invite ───────────────────────────────────────────────────
router.post("/team/invite", async (req, res) => {
  const { userId } = getAuth(req);
  const pub = await getUserPub(userId);

  if (!canInvite(pub)) {
    return res.status(403).json({ error: "You don't have permission to invite users" });
  }

  const adminId = getAdminUserId(pub, userId);
  if (!adminId) {
    return res.status(400).json({ error: "No admin context found" });
  }

  await ensureInvitesLoaded(adminId);

  const { email } = req.body;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email is required" });
  }

  const normalizedEmail = email.toLowerCase().trim();

  const adminUser = adminId === userId ? null : await clerk.users.getUser(adminId);
  const adminPub = adminId === userId ? pub : adminUser?.publicMetadata;

  const deviceInfo = {
    adminUserId: adminId,
    deviceId: adminPub?.deviceId || pub?.deviceId,
    homeId: adminPub?.homeId || pub?.homeId,
    deviceName: adminPub?.deviceName || pub?.deviceName,
  };

  // Store invite in memory + admin's privateMetadata
  emailInvites.set(normalizedEmail, deviceInfo);

  try {
    const admin = await clerk.users.getUser(adminId);
    const priv = admin.privateMetadata || {};
    const pending = (priv.pendingEmailInvites || []).filter(
      (e) => e.email.toLowerCase() !== normalizedEmail
    );
    pending.push({ email: normalizedEmail, createdAt: Date.now() });

    await clerk.users.updateUserMetadata(adminId, {
      privateMetadata: { ...priv, pendingEmailInvites: pending },
    });
  } catch (err) {
    console.error("[team] Failed to persist email invite:", err.message);
  }

  // Send signup invitation via Clerk Invitations API
  try {
    const appUrl = process.env.APP_URL || "https://boiler.parligator.com";
    const invitation = await clerk.invitations.createInvitation({
      emailAddress: normalizedEmail,
      redirectUrl: appUrl,
      ignoreExisting: true,
      publicMetadata: {
        invitedBy: adminId,
        deviceName: deviceInfo.deviceName,
      },
    });
    console.log(`[team] Clerk invitation sent to ${normalizedEmail}, id=${invitation.id}, status=${invitation.status}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[team] Clerk invitation failed for ${normalizedEmail}:`, err.message, err.errors || "");
    return res.status(500).json({ error: `Failed to send invitation email: ${err.message}` });
  }
});

// ── GET /api/team/check-invite ──────────────────────────────────────────────
router.get("/team/check-invite", async (req, res) => {
  const { userId } = getAuth(req);

  try {
    const user = await clerk.users.getUser(userId);
    const email = user.emailAddresses?.[0]?.emailAddress?.toLowerCase();

    if (!email) {
      return res.json({ hasInvite: false });
    }

    const invite = emailInvites.get(email);
    if (invite) {
      return res.json({
        hasInvite: true,
        adminUserId: invite.adminUserId,
        deviceName: invite.deviceName,
        deviceId: invite.deviceId,
        homeId: invite.homeId,
      });
    }

    // Also check if any admin has this email in their pendingEmailInvites
    // (handles case where server restarted and admin's invites haven't been loaded yet)
    // We search by looking up all users — but to keep it efficient, just return false
    // The invite will be found once the admin's invites are loaded on their next request.

    res.json({ hasInvite: false });
  } catch (err) {
    console.error("[team] Check invite error:", err.message);
    res.json({ hasInvite: false });
  }
});

// ── POST /api/team/accept-invite ────────────────────────────────────────────
router.post("/team/accept-invite", async (req, res) => {
  const { userId } = getAuth(req);

  try {
    const user = await clerk.users.getUser(userId);
    const email = user.emailAddresses?.[0]?.emailAddress?.toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "No email found on your account" });
    }

    const invite = emailInvites.get(email);
    if (!invite) {
      return res.status(404).json({ error: "No pending invite found" });
    }

    if (invite.adminUserId === userId) {
      return res.status(400).json({ error: "You can't join your own team" });
    }

    // Set member's publicMetadata
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: {
        deviceId: invite.deviceId,
        homeId: invite.homeId,
        deviceName: invite.deviceName,
        configured: true,
        role: "member",
        adminUserId: invite.adminUserId,
        canInvite: false,
      },
    });

    // Add to admin's team list
    const admin = await clerk.users.getUser(invite.adminUserId);
    const adminPub = admin.publicMetadata || {};
    const team = adminPub.team || [];
    if (!team.some((m) => m.userId === userId)) {
      team.push({ userId, email, canInvite: false });
    }
    await clerk.users.updateUserMetadata(invite.adminUserId, {
      publicMetadata: { ...adminPub, team },
    });

    // Remove email invite
    emailInvites.delete(email);
    const adminPriv = admin.privateMetadata || {};
    const remaining = (adminPriv.pendingEmailInvites || []).filter(
      (e) => e.email.toLowerCase() !== email
    );
    await clerk.users.updateUserMetadata(invite.adminUserId, {
      privateMetadata: { ...adminPriv, pendingEmailInvites: remaining },
    });

    console.log(`[team] User ${userId} accepted email invite from admin ${invite.adminUserId}`);
    res.json({ success: true, deviceName: invite.deviceName });
  } catch (err) {
    console.error("[team] Accept invite error:", err.message);
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

// ── GET /api/team/info ──────────────────────────────────────────────────────
router.get("/team/info", async (req, res) => {
  const { userId } = getAuth(req);
  const pub = await getUserPub(userId);

  if (!pub?.configured) {
    return res.json({ configured: false });
  }

  const role = pub.role || "admin"; // backward compat

  if (isAdmin(pub)) {
    await ensureInvitesLoaded(userId);

    // Enrich team list with display names
    const team = pub.team || [];
    const enriched = [];
    for (const member of team) {
      try {
        const u = await clerk.users.getUser(member.userId);
        enriched.push({
          userId: member.userId,
          email: member.email || u.emailAddresses?.[0]?.emailAddress || "",
          name: [u.firstName, u.lastName].filter(Boolean).join(" ") || member.email,
          canInvite: member.canInvite || false,
          imageUrl: u.imageUrl,
        });
      } catch {
        enriched.push({ ...member, name: member.email });
      }
    }

    const pendingEmailCount = [...emailInvites.values()].filter(
      (e) => e.adminUserId === userId
    ).length;

    return res.json({
      configured: true,
      role,
      team: enriched,
      pendingEmailInvites: pendingEmailCount,
    });
  }

  // Member
  try {
    const admin = await clerk.users.getUser(pub.adminUserId);
    const adminName = [admin.firstName, admin.lastName].filter(Boolean).join(" ")
      || admin.emailAddresses?.[0]?.emailAddress || "Admin";

    res.json({
      configured: true,
      role,
      canInvite: pub.canInvite || false,
      adminName,
      deviceName: pub.deviceName,
    });
  } catch {
    res.json({ configured: true, role, canInvite: pub.canInvite || false });
  }
});

// ── GET /api/team/members ───────────────────────────────────────────────────
router.get("/team/members", async (req, res) => {
  const { userId } = getAuth(req);
  const pub = await getUserPub(userId);

  if (!isAdmin(pub)) {
    return res.status(403).json({ error: "Admin access required" });
  }

  const team = pub.team || [];
  const members = [];
  for (const member of team) {
    try {
      const u = await clerk.users.getUser(member.userId);
      members.push({
        userId: member.userId,
        email: u.emailAddresses?.[0]?.emailAddress || member.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || member.email,
        canInvite: member.canInvite || false,
        imageUrl: u.imageUrl,
      });
    } catch {
      members.push({ ...member, name: member.email });
    }
  }

  res.json({ members });
});

// ── DELETE /api/team/members/:memberId ──────────────────────────────────────
router.delete("/team/members/:memberId", async (req, res) => {
  const { userId } = getAuth(req);
  const pub = await getUserPub(userId);

  if (!isAdmin(pub)) {
    return res.status(403).json({ error: "Admin access required" });
  }

  const memberId = req.params.memberId;

  try {
    // Remove from admin's team list
    const admin = await clerk.users.getUser(userId);
    const adminPub = admin.publicMetadata || {};
    const team = (adminPub.team || []).filter((m) => m.userId !== memberId);
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: { ...adminPub, team },
    });

    // Clear member's metadata (reset to unconfigured)
    await clerk.users.updateUserMetadata(memberId, {
      publicMetadata: {},
    });

    console.log(`[team] Admin ${userId} removed member ${memberId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[team] Remove member error:", err.message);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// ── PUT /api/team/members/:memberId/permissions ─────────────────────────────
router.put("/team/members/:memberId/permissions", async (req, res) => {
  const { userId } = getAuth(req);
  const pub = await getUserPub(userId);

  if (!isAdmin(pub)) {
    return res.status(403).json({ error: "Admin access required" });
  }

  const memberId = req.params.memberId;
  const { canInvite: canInviteVal } = req.body;

  if (typeof canInviteVal !== "boolean") {
    return res.status(400).json({ error: "canInvite (boolean) is required" });
  }

  try {
    // Update admin's team list
    const admin = await clerk.users.getUser(userId);
    const adminPub = admin.publicMetadata || {};
    const team = (adminPub.team || []).map((m) =>
      m.userId === memberId ? { ...m, canInvite: canInviteVal } : m
    );
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: { ...adminPub, team },
    });

    // Update member's publicMetadata
    const member = await clerk.users.getUser(memberId);
    const memberPub = member.publicMetadata || {};
    await clerk.users.updateUserMetadata(memberId, {
      publicMetadata: { ...memberPub, canInvite: canInviteVal },
    });

    console.log(`[team] Updated permissions for ${memberId}: canInvite=${canInviteVal}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[team] Update permissions error:", err.message);
    res.status(500).json({ error: "Failed to update permissions" });
  }
});

// ── POST /api/team/leave ────────────────────────────────────────────────────
router.post("/team/leave", async (req, res) => {
  const { userId } = getAuth(req);
  const pub = await getUserPub(userId);

  if (pub?.role !== "member" || !pub?.adminUserId) {
    return res.status(400).json({ error: "You are not a team member" });
  }

  try {
    // Remove from admin's team list
    const admin = await clerk.users.getUser(pub.adminUserId);
    const adminPub = admin.publicMetadata || {};
    const team = (adminPub.team || []).filter((m) => m.userId !== userId);
    await clerk.users.updateUserMetadata(pub.adminUserId, {
      publicMetadata: { ...adminPub, team },
    });

    // Clear own metadata
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: {},
    });

    console.log(`[team] Member ${userId} left team of admin ${pub.adminUserId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[team] Leave error:", err.message);
    res.status(500).json({ error: "Failed to leave team" });
  }
});

export default router;
