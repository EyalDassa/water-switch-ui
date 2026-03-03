// Distinct color palette for schedules — used on clock arcs and schedule list
export const PALETTE = [
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
export const PALETTE_LIGHT = [
  "#93bbfd", // blue
  "#6ee7b7", // emerald
  "#fcd34d", // amber
  "#c4b5fd", // violet
  "#fca5a5", // red
  "#67e8f9", // cyan
  "#f9a8d4", // pink
  "#fdba74", // orange
];

/** Register an explicit color index for a groupId (from schedule data) */
const explicitColors = new Map<string, number>();

export function setScheduleColorIndex(groupId: string, index: number) {
  explicitColors.set(groupId, index % PALETTE.length);
}

/**
 * Returns a stable color for a given schedule groupId.
 * Uses explicit color if set, otherwise auto-assigns.
 */
const autoColors = new Map<string, number>();

export function getScheduleColor(groupId: string): string {
  if (explicitColors.has(groupId)) return PALETTE[explicitColors.get(groupId)!];
  if (!autoColors.has(groupId)) {
    autoColors.set(groupId, autoColors.size % PALETTE.length);
  }
  return PALETTE[autoColors.get(groupId)!];
}

export function getScheduleColorLight(groupId: string): string {
  if (explicitColors.has(groupId)) return PALETTE_LIGHT[explicitColors.get(groupId)!];
  if (!autoColors.has(groupId)) {
    autoColors.set(groupId, autoColors.size % PALETTE.length);
  }
  return PALETTE_LIGHT[autoColors.get(groupId)!];
}

export function getColorIndex(groupId: string): number {
  if (explicitColors.has(groupId)) return explicitColors.get(groupId)!;
  if (autoColors.has(groupId)) return autoColors.get(groupId)!;
  return 0;
}
