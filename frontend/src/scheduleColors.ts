// Distinct color palette for schedules — used on clock arcs and schedule list
const PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#f97316", // orange
];

// Light fills for arcs (lower opacity versions)
const PALETTE_LIGHT = [
  "#93bbfd", // blue
  "#6ee7b7", // emerald
  "#fcd34d", // amber
  "#c4b5fd", // violet
  "#fca5a5", // red
  "#67e8f9", // cyan
  "#f9a8d4", // pink
  "#fdba74", // orange
];

/**
 * Returns a stable color for a given schedule groupId.
 * Same groupId always gets the same color within a session.
 */
const colorCache = new Map<string, number>();

export function getScheduleColor(groupId: string): string {
  if (!colorCache.has(groupId)) {
    colorCache.set(groupId, colorCache.size % PALETTE.length);
  }
  return PALETTE[colorCache.get(groupId)!];
}

export function getScheduleColorLight(groupId: string): string {
  if (!colorCache.has(groupId)) {
    colorCache.set(groupId, colorCache.size % PALETTE.length);
  }
  return PALETTE_LIGHT[colorCache.get(groupId)!];
}
