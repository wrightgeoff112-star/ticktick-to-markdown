/** Read-only backup when the official CSV generator is temporarily unavailable.
 * Preserve raw API records; never label this output as an official CSV.
 */
import type { CsvFolder, CsvList, CsvParseResult, CsvTask } from "./csv.js";
import {
  fetchCompletedWindowComplete,
  parseProjectTasksResponse,
  type RawRecord,
} from "./image-api.js";
import type { ManifestGap } from "./manifest.js";
import { parseDidaRepeatRule } from "./recurrence.js";
import { parseDidaReminderRules } from "./reminder-rules.js";
export interface ApiBackup {
  csv: CsvParseResult;
  batch: RawRecord;
  records: RawRecord[];
  rawJson: string;
  gaps: ManifestGap[];
}
const string = (v: unknown) => (typeof v === "string" ? v : "");
const date = (v: unknown) => {
  const raw = string(v);
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const objects = (v: unknown): RawRecord[] =>
  Array.isArray(v)
    ? v.filter((x): x is RawRecord => !!x && typeof x === "object")
    : [];
function tasksFromRecords(records: RawRecord[], lists: CsvList[]): CsvTask[] {
  const knownLists = new Map(lists.map((p) => [p.id, p]));
  return records.map((r) => {
    const list = knownLists.get(string(r.projectId));
    const isAllDay = r.isAllDay === true;
    const rawPriority = Number(r.priority) || 0;
    const reminders = objects(r.reminders)
      .map((r) => string(r.trigger).replace(/^TRIGGER:/i, ""))
      .filter(Boolean);
    const items = objects(r.items)
      .map(
        (i) =>
          `- [${Number(i.status) === 2 ? "x" : " "}] ${string(i.title).replace(/[\r\n]/g, " ")}`,
      )
      .join("\n");
    const body = [string(r.content), items].filter(Boolean).join("\n\n");
    const repeat = string(r.repeatFlag);
    return {
      id: `dida-${r.id}`,
      sourceTaskId: string(r.id),
      kind: r.kind === "NOTE" ? "note" : "task",
      title: string(r.title),
      content: body || null,
      status:
        Number(r.status) === 0
          ? "todo"
          : Number(r.status) === -1
            ? "canceled"
            : "done",
      priority:
        rawPriority === 5
          ? 3
          : rawPriority === 3
            ? 2
            : rawPriority === 1
              ? 1
              : null,
      rawPriority,
      listId: list?.id ?? null,
      folderId: list?.folderId ?? null,
      parentId: string(r.parentId) ? `dida-${r.parentId}` : null,
      startDate: date(r.startDate),
      dueDate: date(r.dueDate),
      completedTime: date(r.completedTime),
      createdTime: date(r.createdTime),
      isAllDay,
      timezone: string(r.timeZone) || "UTC",
      tags: Array.isArray(r.tags)
        ? r.tags.filter((x): x is string => typeof x === "string")
        : [],
      attachmentRefs: objects(r.attachments)
        .map((a) => string(a.id) || string(a.refId))
        .filter(Boolean),
      reminderRules: parseDidaReminderRules(reminders.join("\n"), { isAllDay }),
      recurrence: repeat ? parseDidaRepeatRule(repeat) : null,
    };
  });
}
export async function readApiBackup(
  request: (path: string) => Promise<unknown>,
  onProgress: (message: string) => void = () => {},
): Promise<ApiBackup> {
  const response = await request("/api/v2/batch/check/0");
  if (!response || typeof response !== "object")
    throw Error("任务备份接口返回无效数据");
  const batch = response as RawRecord;
  const bean = batch.syncTaskBean as RawRecord | undefined;
  if (
    !Array.isArray(batch.projectProfiles) ||
    !Array.isArray(bean?.update) ||
    typeof batch.inboxId !== "string"
  )
    throw Error("任务备份接口返回不完整");
  const profiles = objects(batch.projectProfiles).filter((p) => !p.deleted);
  const lists: CsvList[] = [
    { id: batch.inboxId, title: "收集箱", folderId: null },
    ...profiles.map((p) => ({
      id: string(p.id),
      title: string(p.name),
      folderId: string(p.groupId) || null,
    })),
  ];
  if (lists.some((p) => !p.id || !p.title)) throw Error("任务备份缺少清单身份");
  const folders: CsvFolder[] = objects(batch.projectGroups)
    .filter((g) => !g.deleted)
    .map((g) => ({ id: string(g.id), title: string(g.name) }));
  const gaps: ManifestGap[] = [];
  const records = new Map<string, RawRecord>();
  function add(rows: RawRecord[]) {
    if (
      rows.some(
        (r) =>
          !string(r.id) || !string(r.projectId) || typeof r.title !== "string",
      )
    )
      throw Error("任务备份缺少必要字段");
    for (const r of rows) if (!r.deleted) records.set(string(r.id), r);
  }
  add(bean!.update as RawRecord[]);
  // Batch has active inbox tasks; every project is read explicitly to include archived lists.
  for (const profile of profiles) {
    onProgress(`正在读取清单：${profile.name}`);
    try {
      add(
        parseProjectTasksResponse(
          await request(
            `/api/v2/project/${encodeURIComponent(string(profile.id))}/tasks`,
          ),
        ),
      );
    } catch (error) {
      gaps.push({
        code: "task_attachment_unreachable",
        message: `清单「${profile.name}」未完整读取：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const from = 0,
    to = Date.now() + 86400000;
  const center = new Date((from + to) / 2).toISOString(),
    windowHours = (to - from) / 2 / 3600000;
  for (const status of [undefined, "Abandoned"] as const) {
    onProgress(status ? "正在读取已放弃任务…" : "正在读取完整历史任务…");
    try {
      add(
        await fetchCompletedWindowComplete(
          "all",
          center,
          { global: true, windowHours, ...(status ? { status } : {}) },
          request,
        ),
      );
    } catch (error) {
      gaps.push({
        code: "completed_scan_incomplete",
        message: `${status ? "已放弃" : "已完成"}历史未完整读取：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const all = [...records.values()];
  for (const r of all)
    if (!lists.some((l) => l.id === r.projectId)) {
      lists.push({
        id: string(r.projectId),
        title: `清单 ${r.projectId}`,
        folderId: null,
      });
      gaps.push({
        code: "task_attachment_unreachable",
        taskId: `dida-${r.id}`,
        message: `清单 ${r.projectId} 的名称未取得，原始任务仍已保留。`,
      });
    }
  const tasks = tasksFromRecords(all, lists);
  const csv: CsvParseResult = {
    tasks,
    lists,
    folders,
    warnings: [],
    summary: {
      totalRows: tasks.length,
      importedTasks: tasks.length,
      withRepeat: tasks.filter((t) => t.recurrence).length,
      withReminder: tasks.filter((t) => t.reminderRules.length).length,
      withAttachmentRefs: tasks.filter((t) => t.attachmentRefs.length).length,
    },
  };
  return {
    csv,
    batch,
    records: all,
    gaps,
    rawJson:
      JSON.stringify(
        {
          source: "task-api",
          generatedAt: new Date().toISOString(),
          batch,
          tasks: all,
        },
        null,
        2,
      ) + "\n",
  };
}
