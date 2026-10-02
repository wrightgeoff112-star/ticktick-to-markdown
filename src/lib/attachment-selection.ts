import type { TaskStatus } from "./csv.js";
import type { AttachmentCandidate } from "./enrich.js";

export interface AttachmentFilter {
  scope: "all" | "todo" | "active" | "recent" | "custom" | "none";
  listId: string | null;
  includeNotes: boolean;
  dateField: "created" | "completed";
  status: TaskStatus | "all";
  /** Local calendar dates, YYYY-MM-DD. */
  from: string;
  to: string;
  now?: Date;
}
export function filterAttachments(
  entries: readonly AttachmentCandidate[],
  filter: AttachmentFilter,
): AttachmentCandidate[] {
  const now = filter.now ?? new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  cutoff.setHours(0, 0, 0, 0);
  const from = filter.from
    ? new Date(`${filter.from}T00:00:00`).getTime()
    : -Infinity;
  const end = filter.to ? new Date(`${filter.to}T00:00:00`) : undefined;
  end?.setDate(end.getDate() + 1);
  const to = end?.getTime() ?? Infinity;
  if (
    filter.scope === "none" ||
    (filter.scope === "custom" &&
      (from >= to || Number.isNaN(from) || Number.isNaN(to)))
  )
    return [];
  const recent = (value: string | null) => {
    const date = value ? Date.parse(value) : NaN;
    return date >= cutoff.getTime() && date <= now.getTime();
  };
  return entries.filter(({ task }) => {
    if (filter.listId && task.listId !== filter.listId) return false;
    if (task.kind === "note" && !filter.includeNotes) return false;
    switch (filter.scope) {
      case "all":
        return true;
      case "todo":
        return task.kind === "note" || task.status === "todo";
      case "active":
        return task.kind === "note"
          ? recent(task.createdTime)
          : task.status === "todo" ||
              (task.status === "done" && recent(task.completedTime));
      case "recent":
        return recent(task.createdTime);
      case "custom": {
        if (
          filter.dateField === "completed" &&
          (task.kind === "note" ||
            task.status !== "done" ||
            !["all", "done"].includes(filter.status))
        )
          return false;
        if (
          task.kind !== "note" &&
          filter.status !== "all" &&
          task.status !== filter.status
        )
          return false;
        const value =
          filter.dateField === "created"
            ? task.createdTime
            : task.completedTime;
        const time = value ? Date.parse(value) : NaN;
        return time >= from && time < to;
      }
    }
  });
}

export function estimateAttachments(entries: readonly AttachmentCandidate[]) {
  let knownBytes = 0,
    unknownCount = 0;
  for (const { meta } of entries) {
    if (meta.size != null && Number.isFinite(meta.size) && meta.size >= 0)
      knownBytes += meta.size;
    else unknownCount++;
  }
  return { count: entries.length, knownBytes, unknownCount };
}

export function newestAttachments(entries: readonly AttachmentCandidate[]) {
  const time = (entry: AttachmentCandidate) => {
    const parsed = Date.parse(entry.task.createdTime ?? "");
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...entries].sort(
    (a, b) => time(b) - time(a) || a.key.localeCompare(b.key),
  );
}
