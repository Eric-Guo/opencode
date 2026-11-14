export const telegramMenu = [
  {
    command: "help",
    description: "Show commands and usage",
    usage: "help",
  },
  {
    command: "status",
    description: "Show current work or one accepted task",
    usage: "status [TASK_ID]",
  },
  {
    command: "queue",
    description: "View or change waiting requests",
    usage: "queue [list|edit NUMBER TEXT|reschedule NUMBER TIME|cancel NUMBER]",
  },
  {
    command: "remind",
    description: "Schedule a one-time reminder in this chat",
    usage: "remind in DURATION TEXT | /remind at TIME TEXT",
  },
  {
    command: "job",
    description: "Manage independently scheduled tasks",
    usage:
      "job list|show ID|history ID|create once in DURATION TEXT|create every DURATION TEXT|create daily HH:MM TIME_ZONE TEXT|edit ID FIELD VALUE|pause ID|resume ID|cancel ID",
  },
  {
    command: "destinations",
    description: "List chats available for result delivery",
    usage: "destinations",
  },
  {
    command: "deliver",
    description: "Choose where a task sends its results",
    usage: "deliver TASK_ID DESTINATION",
  },
  {
    command: "sessions",
    description: "List this chat's conversations",
    usage: "sessions [PAGE]",
  },
  {
    command: "resume",
    description: "Return to one of your conversations",
    usage: "resume ID",
  },
  {
    command: "search",
    description: "Search this chat's saved conversations",
    usage: "search TEXT|next",
  },
  {
    command: "history",
    description: "Read history or change its visibility",
    usage: "history [before POSITION|hide|show|exclude|include|delete|restore TURN_ID]",
  },
  {
    command: "rename",
    description: "Rename the selected conversation",
    usage: "rename TITLE",
  },
  {
    command: "archive",
    description: "Archive a saved conversation",
    usage: "archive [ID]",
  },
  {
    command: "restore",
    description: "Restore an archived conversation",
    usage: "restore [ID]",
  },
  {
    command: "fork",
    description: "Branch history and keep current files",
    usage: "fork [POSITION]",
  },
  {
    command: "regenerate",
    description: "Generate another answer and keep current files",
    usage: "regenerate [POSITION]",
  },
  {
    command: "variants",
    description: "List a turn's answer candidates",
    usage: "variants POSITION",
  },
  {
    command: "variant",
    description: "Select, hide or restore an answer candidate",
    usage: "variant POSITION ID [hide|restore]",
  },
  {
    command: "edit",
    description: "Edit the tail as a new candidate",
    usage: "edit POSITION TEXT",
  },
  {
    command: "undo",
    description: "Delete the newest turn",
    usage: "undo",
  },
  {
    command: "task",
    description: "Control an accepted task's execution",
    usage: "task pause|resume|retry|abandon [TASK_ID] [TASK_KEY]",
  },
  {
    command: "transcript",
    description: "Read the selected task's execution trace",
    usage: "transcript [TASK_ID] [branch PREFIX] [before CURSOR]",
  },
  {
    command: "context",
    description: "Preview the next request's context",
    usage: "context",
  },
  {
    command: "compact",
    description: "Compact the selected conversation",
    usage: "compact",
  },
  {
    command: "memory",
    description: "Manage the selected conversation's memory",
    usage: "memory ls|read PATH|write PATH TEXT|edit JSON|grep TEXT|delete PATH",
  },
  {
    command: "settings",
    description: "Show group behavior and your conversation settings",
    usage: "settings",
  },
  {
    command: "new",
    description: "Start a new conversation",
    usage: "new",
  },
  {
    command: "stop",
    description: "Stop the selected task and its background work",
    usage: "stop [TASK_ID]",
  },
  {
    command: "steer",
    description: "Add instructions to the selected running task",
    usage: "steer <text> | /steer TASK_ID <text>",
  },
  {
    command: "model",
    description: "List or choose a model",
    usage: "model [provider/model]",
  },
  {
    command: "codemode",
    description: "Explain why Bots do not use Code Mode",
    usage: "codemode",
  },
  {
    command: "workspace",
    description: "List, choose or create this chat's workspace",
    usage: "workspace [list|current|use ID|create NAME]",
  },
  {
    command: "observe",
    description: "View group background context; owner can change it",
    usage: "observe [on|off|status]",
  },
  {
    command: "mode",
    description: "View group participation; owner can change it",
    usage: "mode [assistant|active|status]",
  },
  {
    command: "voice",
    description: "Choose spoken replies, with text kept",
    usage: "voice off|voice_only|all",
  },
  {
    command: "approve",
    description: "Approve a pending request",
    usage: "approve ID",
  },
  {
    command: "deny",
    description: "Decline a pending request",
    usage: "deny ID",
  },
  {
    command: "answer",
    description: "Answer your task's pending question",
    usage: "answer ID your answer",
  },
  {
    command: "access",
    description: "Manage who can interact with the bot",
    usage: "access users|chats list|add|remove [ID]",
  },
  {
    command: "ignore",
    description: "Ignore or restore someone's new messages",
    usage: "ignore list|add|remove [ID]",
  },
]

export const telegramHelp =
  "Send a message to start. In groups, mention me or reply to your task receipt or answer.\n" +
  telegramMenu.map((row) => "/" + row.usage + " — " + row.description).join("\n") +
  "\nYou can also reply to a question message with your answer."
