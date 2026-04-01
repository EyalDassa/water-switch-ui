import { Router } from "express";
import { getAuth } from "@clerk/express";
import { createClerkClient } from "@clerk/express";
import { defaultClient as tuya } from "../tuya.js";
import { startGuard, stopGuard } from "../activationGuard.js";
import { createLogger } from "../logger.js";

const log = createLogger("team");

const router = Router();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

/** Wrap async route handlers so unhandled errors return 500 instead of crashing */
const safe = (fn) => (req, res, next) => fn(req, res, next).catch(next);

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

/**
 * Resolve invite info from user's Clerk metadata.
 * Works for both new signups (Clerk copies invitation publicMetadata)
 * and existing users (we set invitedBy directly on invite).
 */
async function resolveInvite(user) {
  const pub = user.publicMetadata || {};
  if (pub.invitedBy && !pub.configured) {
    const admin = await clerk.users.getUser(pub.invitedBy);
    const adminPub = admin.publicMetadata || {};
    const email = user.emailAddresses?.[0]?.emailAddress?.toLowerCase();
    log.info(` Resolved invite for ${email} → admin ${pub.invitedBy}`);
    return {
      adminUserId: pub.invitedBy,
      deviceId: adminPub.deviceId,
      homeId: adminPub.homeId,
      deviceName: pub.deviceName || adminPub.deviceName,
    };
  }
  return null;
}

// ── POST /api/team/invite ───────────────────────────────────────────────────
router.post(
  "/team/invite",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const pub = await getUserPub(userId);

    if (!canInvite(pub)) {
      return res
        .status(403)
        .json({ error: "You don't have permission to invite users" });
    }

    const adminId = getAdminUserId(pub, userId);
    if (!adminId) {
      return res.status(400).json({ error: "No admin context found" });
    }

    const { email } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const adminUser =
      adminId === userId ? null : await clerk.users.getUser(adminId);
    const adminPub = adminId === userId ? pub : adminUser?.publicMetadata;

    const deviceInfo = {
      adminUserId: adminId,
      deviceId: adminPub?.deviceId || pub?.deviceId,
      homeId: adminPub?.homeId || pub?.homeId,
      deviceName: adminPub?.deviceName || pub?.deviceName,
    };

    // Persist invite in admin's privateMetadata
    try {
      const admin = await clerk.users.getUser(adminId);
      const priv = admin.privateMetadata || {};
      const pending = (priv.pendingEmailInvites || []).filter(
        (e) => e.email.toLowerCase() !== normalizedEmail,
      );
      pending.push({ email: normalizedEmail, createdAt: Date.now() });

      await clerk.users.updateUserMetadata(adminId, {
        privateMetadata: { ...priv, pendingEmailInvites: pending },
      });
    } catch (err) {
      log.error(" Failed to persist email invite:", err.message);
    }

    // If the invited user already has a Clerk account, set invitedBy directly
    // on their metadata so resolveInvite() works without needing in-memory state
    try {
      const existingUsers = await clerk.users.getUserList({
        emailAddress: [normalizedEmail],
      });
      if (existingUsers.data.length > 0) {
        const existing = existingUsers.data[0];
        if (!existing.publicMetadata?.configured) {
          await clerk.users.updateUserMetadata(existing.id, {
            publicMetadata: {
              ...existing.publicMetadata,
              invitedBy: adminId,
              deviceName: deviceInfo.deviceName,
            },
          });
          log.info(
            `[team] Set invitedBy on existing user ${normalizedEmail}`,
          );
        }
      }
    } catch (err) {
      log.info(
        `[team] Could not set invitedBy on existing user: ${err.message}`,
      );
    }

    // Send signup invitation via Clerk Invitations API
    // For new users: sends email + sets invitedBy in their metadata on signup
    // For existing users: may fail, but we already set invitedBy above
    try {
      const appUrl = process.env.APP_URL;
      const invitation = await clerk.invitations.createInvitation({
        emailAddress: normalizedEmail,
        redirectUrl: appUrl,
        ignoreExisting: true,
        publicMetadata: {
          invitedBy: adminId,
          deviceName: deviceInfo.deviceName,
        },
      });
      log.info(
        `[team] Clerk invitation sent to ${normalizedEmail}, id=${invitation.id}, status=${invitation.status}`,
      );
    } catch (err) {
      log.info(` Clerk invitation API note: ${err.message}`);
    }

    return res.json({ success: true });
  }),
);

// ── GET /api/team/check-invite ──────────────────────────────────────────────
router.get(
  "/team/check-invite",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const user = await clerk.users.getUser(userId);

    const invite = await resolveInvite(user);
    if (invite) {
      return res.json({
        hasInvite: true,
        adminUserId: invite.adminUserId,
        deviceName: invite.deviceName,
        deviceId: invite.deviceId,
        homeId: invite.homeId,
      });
    }

    res.json({ hasInvite: false });
  }),
);

// ── POST /api/team/accept-invite ────────────────────────────────────────────
router.post(
  "/team/accept-invite",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const user = await clerk.users.getUser(userId);
    const email = user.emailAddresses?.[0]?.emailAddress?.toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "No email found on your account" });
    }

    const invite = await resolveInvite(user);
    if (!invite) {
      return res.status(404).json({ error: "No pending invite found" });
    }

    if (invite.adminUserId === userId) {
      return res
        .status(400)
        .json({ error: "You can't join your own household" });
    }

    // Set member's publicMetadata (replaces invitedBy with full member config)
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

    // Clean up pending invite from admin's privateMetadata
    const adminPriv = admin.privateMetadata || {};
    const remaining = (adminPriv.pendingEmailInvites || []).filter(
      (e) => e.email.toLowerCase() !== email,
    );
    await clerk.users.updateUserMetadata(invite.adminUserId, {
      privateMetadata: { ...adminPriv, pendingEmailInvites: remaining },
    });

    log.info(
      `[team] User ${userId} (${email}) accepted invite from admin ${invite.adminUserId}`,
    );
    res.json({ success: true, deviceName: invite.deviceName });
  }),
);

// ── GET /api/team/info ──────────────────────────────────────────────────────
router.get(
  "/team/info",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const admin = await clerk.users.getUser(userId);
    const pub = admin.publicMetadata || {};

    if (!pub?.configured) {
      return res.json({ configured: false });
    }

    const role = pub.role || "admin"; // backward compat

    if (isAdmin(pub)) {
      const team = pub.team || [];

      // Self-healing: find members whose metadata points to this admin
      // but aren't in the team array (fixes data out-of-sync issues)
      try {
        const allUsers = await clerk.users.getUserList({ limit: 100 });
        let synced = false;
        for (const u of allUsers.data) {
          const uPub = u.publicMetadata || {};
          if (uPub.role === "member" && uPub.adminUserId === userId) {
            if (!team.some((m) => m.userId === u.id)) {
              const email = u.emailAddresses?.[0]?.emailAddress || "";
              team.push({
                userId: u.id,
                email,
                canInvite: uPub.canInvite || false,
              });
              synced = true;
              log.info(
                `[team] Auto-synced missing member ${u.id} (${email}) into admin's team`,
              );
            }
          }
        }
        if (synced) {
          await clerk.users.updateUserMetadata(userId, {
            publicMetadata: { ...pub, team },
          });
        }
      } catch (err) {
        log.error(" Reconciliation check failed:", err.message);
      }

      // Enrich team list with display names (batch fetch)
      let enriched = team.map((m) => ({ ...m, name: m.email, canInvite: m.canInvite || false }));
      try {
        const userIds = team.map((m) => m.userId);
        const users = await clerk.users.getUserList({ userId: userIds, limit: 100 });
        const userMap = new Map(users.data.map((u) => [u.id, u]));
        enriched = team.map((member) => {
          const u = userMap.get(member.userId);
          return {
            userId: member.userId,
            email: member.email || u?.emailAddresses?.[0]?.emailAddress || "",
            name: u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || member.email : member.email,
            canInvite: member.canInvite || false,
            imageUrl: u?.imageUrl,
          };
        });
      } catch {
        // Fallback: use email as name
      }

      // Read pending invite count from admin's privateMetadata
      const priv = admin.privateMetadata || {};
      const pendingEmailCount = (priv.pendingEmailInvites || []).length;

      return res.json({
        configured: true,
        role,
        deviceName: pub.deviceName || null,
        team: enriched,
        pendingEmailInvites: pendingEmailCount,
      });
    }

    // Member — also return team list so they can see other members
    try {
      const adminUser = await clerk.users.getUser(pub.adminUserId);
      const adminPub = adminUser.publicMetadata || {};
      const adminName =
        [adminUser.firstName, adminUser.lastName].filter(Boolean).join(" ") ||
        adminUser.emailAddresses?.[0]?.emailAddress ||
        "Admin";

      // Build team list: admin + all members
      const teamList = adminPub.team || [];
      const enriched = [];

      // Add admin first
      enriched.push({
        userId: pub.adminUserId,
        email: adminUser.emailAddresses?.[0]?.emailAddress || "",
        name: adminName,
        role: "admin",
        imageUrl: adminUser.imageUrl,
      });

      // Add other members (batch fetch)
      try {
        const memberIds = teamList.map((m) => m.userId);
        const users = await clerk.users.getUserList({ userId: memberIds, limit: 100 });
        const userMap = new Map(users.data.map((u) => [u.id, u]));
        for (const member of teamList) {
          const u = userMap.get(member.userId);
          enriched.push({
            userId: member.userId,
            email: u?.emailAddresses?.[0]?.emailAddress || member.email,
            name: u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || member.email : member.email,
            role: "member",
            imageUrl: u?.imageUrl,
          });
        }
      } catch {
        for (const member of teamList) {
          enriched.push({ ...member, name: member.email, role: "member" });
        }
      }

      res.json({
        configured: true,
        role,
        canInvite: pub.canInvite || false,
        adminName,
        deviceName: pub.deviceName,
        team: enriched,
      });
    } catch {
      res.json({ configured: true, role, canInvite: pub.canInvite || false });
    }
  }),
);

// ── PUT /api/team/device-name ────────────────────────────────────────────────
router.put(
  "/team/device-name",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const pub = await getUserPub(userId);

    if (!isAdmin(pub)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { deviceName } = req.body;
    if (!deviceName || typeof deviceName !== "string" || !deviceName.trim()) {
      return res.status(400).json({ error: "deviceName is required" });
    }

    const trimmed = deviceName.trim().slice(0, 50);

    // Update on Tuya side
    if (pub.deviceId) {
      try {
        await tuya.put(`/v1.0/devices/${pub.deviceId}`, { name: trimmed });
        log.info(
          `[team] Tuya device ${pub.deviceId} renamed to "${trimmed}"`,
        );
      } catch (err) {
        log.warn(` Failed to rename on Tuya: ${err.message}`);
      }
    }

    // Update admin's own metadata
    const admin = await clerk.users.getUser(userId);
    const adminPub = admin.publicMetadata || {};
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: { ...adminPub, deviceName: trimmed },
    });

    // Update all team members
    const team = adminPub.team || [];
    for (const member of team) {
      try {
        const u = await clerk.users.getUser(member.userId);
        const uPub = u.publicMetadata || {};
        await clerk.users.updateUserMetadata(member.userId, {
          publicMetadata: { ...uPub, deviceName: trimmed },
        });
      } catch (err) {
        log.error(
          `Failed to update deviceName for member ${member.userId}: ${err.message}`,
        );
      }
    }

    log.info(` Admin ${userId} updated deviceName to "${trimmed}"`);
    res.json({ success: true, deviceName: trimmed });
  }),
);

// ── GET /api/team/members ───────────────────────────────────────────────────
router.get(
  "/team/members",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const pub = await getUserPub(userId);

    if (!isAdmin(pub)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const team = pub.team || [];
    let members = team.map((m) => ({ ...m, name: m.email }));
    try {
      const userIds = team.map((m) => m.userId);
      const users = await clerk.users.getUserList({ userId: userIds, limit: 100 });
      const userMap = new Map(users.data.map((u) => [u.id, u]));
      members = team.map((member) => {
        const u = userMap.get(member.userId);
        return {
          userId: member.userId,
          email: u?.emailAddresses?.[0]?.emailAddress || member.email,
          name: u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || member.email : member.email,
          canInvite: member.canInvite || false,
          imageUrl: u?.imageUrl,
        };
      });
    } catch {
      // Fallback: use email as name
    }

    res.json({ members });
  }),
);

// ── DELETE /api/team/members/:memberId ──────────────────────────────────────
router.delete(
  "/team/members/:memberId",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const pub = await getUserPub(userId);

    if (!isAdmin(pub)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const memberId = req.params.memberId;

    // Remove from admin's team list
    const admin = await clerk.users.getUser(userId);
    const adminPub = admin.publicMetadata || {};
    const team = (adminPub.team || []).filter((m) => m.userId !== memberId);
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: { ...adminPub, team },
    });

    // Clear member's metadata (set keys to null — Clerk deep-merges, so {} is a no-op)
    await clerk.users.updateUserMetadata(memberId, {
      publicMetadata: {
        role: null,
        adminUserId: null,
        configured: null,
        deviceId: null,
        homeId: null,
        deviceName: null,
        canInvite: null,
        invitedBy: null,
      },
    });

    log.info(` Admin ${userId} removed member ${memberId}`);
    res.json({ success: true });
  }),
);

// ── PUT /api/team/members/:memberId/permissions ─────────────────────────────
router.put(
  "/team/members/:memberId/permissions",
  safe(async (req, res) => {
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

    // Update admin's team list
    const admin = await clerk.users.getUser(userId);
    const adminPub = admin.publicMetadata || {};
    const team = (adminPub.team || []).map((m) =>
      m.userId === memberId ? { ...m, canInvite: canInviteVal } : m,
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

    log.info(
      `[team] Updated permissions for ${memberId}: canInvite=${canInviteVal}`,
    );
    res.json({ success: true });
  }),
);

// ── POST /api/team/leave ────────────────────────────────────────────────────
router.post(
  "/team/leave",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const pub = await getUserPub(userId);

    if (pub?.role !== "member" || !pub?.adminUserId) {
      return res.status(400).json({ error: "You are not a household member" });
    }

    // Remove from admin's team list
    const admin = await clerk.users.getUser(pub.adminUserId);
    const adminPub = admin.publicMetadata || {};
    const team = (adminPub.team || []).filter((m) => m.userId !== userId);
    await clerk.users.updateUserMetadata(pub.adminUserId, {
      publicMetadata: { ...adminPub, team },
    });

    // Clear own metadata (set keys to null — Clerk deep-merges, so {} is a no-op)
    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: {
        role: null,
        adminUserId: null,
        configured: null,
        deviceId: null,
        homeId: null,
        deviceName: null,
        canInvite: null,
        invitedBy: null,
      },
    });

    log.info(
      `[team] Member ${userId} left team of admin ${pub.adminUserId}`,
    );
    res.json({ success: true });
  }),
);

// ── GET /api/settings ──────────────────────────────────────────────────────
router.get(
  "/settings",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const pub = await getUserPub(userId);
    const adminUserId = getAdminUserId(pub, userId);
    if (!adminUserId) {
      return res.json({ blockExternalActivations: false });
    }

    const adminPub =
      adminUserId === userId
        ? pub
        : (await clerk.users.getUser(adminUserId)).publicMetadata || {};

    const settings = adminPub.settings || {};
    res.json({
      blockExternalActivations: !!settings.blockExternalActivations,
      blockAfterOneHour: !!settings.blockAfterOneHour,
      isAdmin: isAdmin(pub),
    });
  }),
);

// ── PUT /api/settings ──────────────────────────────────────────────────────
router.put(
  "/settings",
  safe(async (req, res) => {
    const { userId } = getAuth(req);
    const pub = await getUserPub(userId);

    if (!isAdmin(pub)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { blockExternalActivations, blockAfterOneHour } = req.body;

    // At least one setting must be provided
    if (
      typeof blockExternalActivations !== "boolean" &&
      typeof blockAfterOneHour !== "boolean"
    ) {
      return res.status(400).json({ error: "No valid settings provided" });
    }

    // Update admin metadata
    const admin = await clerk.users.getUser(userId);
    const adminPub = admin.publicMetadata || {};
    const settings = { ...(adminPub.settings || {}) };

    if (typeof blockExternalActivations === "boolean") {
      settings.blockExternalActivations = blockExternalActivations;
      // If blocking all, disable the delayed option
      if (blockExternalActivations) settings.blockAfterOneHour = false;
    }
    if (typeof blockAfterOneHour === "boolean") {
      settings.blockAfterOneHour = blockAfterOneHour;
      // If enabling delayed, disable immediate block
      if (blockAfterOneHour) settings.blockExternalActivations = false;
    }

    await clerk.users.updateUserMetadata(userId, {
      publicMetadata: { ...adminPub, settings },
    });

    // Start or stop the activation guard
    const deviceId = pub.deviceId || process.env.DEVICE_ID;
    if (settings.blockExternalActivations) {
      startGuard(deviceId, userId, "immediate");
    } else if (settings.blockAfterOneHour) {
      startGuard(deviceId, userId, "delayed");
    } else {
      stopGuard(deviceId);
    }

    log.info(
      `[settings] blockExternalActivations=${settings.blockExternalActivations}, blockAfterOneHour=${settings.blockAfterOneHour} for device ${deviceId?.slice(0, 8)}...`,
    );
    res.json({
      success: true,
      blockExternalActivations: settings.blockExternalActivations,
      blockAfterOneHour: settings.blockAfterOneHour,
    });
  }),
);

// ── Error handler for team routes ───────────────────────────────────────────
router.use((err, req, res, _next) => {
  log.error(" Unhandled error:", err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
