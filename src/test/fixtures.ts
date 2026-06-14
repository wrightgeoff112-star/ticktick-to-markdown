/**
 * A small but representative TickTick/滴答 CSV export fixture.
 *
 * The real export prefixes the header with several metadata lines (Date,
 * Version, Status counts, blank line). The header row has many columns; we
 * include the columns the parser actually reads.
 */

export const SAMPLE_CSV = `"Date: 2026-06-15+0800"
"Version: 7.1"
"Status: 0 Completed: 0"
"Total Number of Tasks: 3"

"Folder Name","List Name","Title","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId","Kind"
"Work","Roadmap","Ship v1","release;urgent","Need to attach the diagram\\n![](abc123/diagram.png)","N","2026-06-10T09:00:00+0800","2026-06-12T18:00:00+0800","-PT30M","RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO","5","0","2026-06-01T08:00:00+0800","","100","Asia/Shanghai","false","","","","","task-1","","TEXT"
"Work","Roadmap","Subtask under ship","","","N","","","","","3","2","2026-06-05T08:00:00+0800","2026-06-11T10:00:00+0800","101","Asia/Shanghai","false","","","","","task-2","task-1","TEXT"
"","Personal","Buy groceries","","Milk and eggs","N","","","PT9H","","1","-1","2026-06-02T08:00:00+0800","","102","Asia/Shanghai","true","","","","","task-3","","TEXT"
`;

export const NO_HEADER_CSV = `"some","random","file"
"that","is","not","a ticktick export"
`;
