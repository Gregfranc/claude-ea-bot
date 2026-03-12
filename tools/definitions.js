// Tool definitions for Claude API function calling
// These define what the agent can do

const OWNER_TOOLS = [
  {
    name: "search_emails",
    description:
      "Search Gmail for emails matching a query. Supports Gmail search syntax (from:, to:, subject:, has:attachment, newer_than:, etc).",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Gmail search query. Examples: "from:brian@example.com", "subject:La Pine", "newer_than:2d"',
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_email",
    description:
      "Read the full content of a specific email by its message ID. Use search_emails first to find the ID.",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to read",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "create_draft",
    description:
      "Create a Gmail draft (does not send). Greg can review and send manually.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email immediately from Greg's Gmail. Use with caution. Prefer create_draft unless Greg explicitly says to send.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "reply_to_email",
    description:
      "Reply to an existing email thread. Sends immediately. Maintains thread context.",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The message ID to reply to",
        },
        body: { type: "string", description: "Reply body text" },
      },
      required: ["message_id", "body"],
    },
  },
  {
    name: "list_calendar_events",
    description:
      "List upcoming calendar events. Shows events for the specified number of days ahead.",
    input_schema: {
      type: "object",
      properties: {
        days_ahead: {
          type: "number",
          description: "Number of days to look ahead (default 7)",
        },
      },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create a new Google Calendar event. Times should be in ISO 8601 format.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        start: {
          type: "string",
          description:
            'Start datetime in ISO 8601 format (e.g. "2026-03-10T14:00:00")',
        },
        end: {
          type: "string",
          description:
            'End datetime in ISO 8601 format (e.g. "2026-03-10T15:00:00")',
        },
        description: {
          type: "string",
          description: "Event description (optional)",
        },
        location: {
          type: "string",
          description: "Event location (optional)",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses (optional)",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "update_calendar_event",
    description:
      "Update an existing calendar event. Use list_calendar_events first to find the event ID.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The calendar event ID" },
        summary: { type: "string", description: "New event title (optional)" },
        start: {
          type: "string",
          description: "New start datetime in ISO 8601 (optional)",
        },
        end: {
          type: "string",
          description: "New end datetime in ISO 8601 (optional)",
        },
        description: {
          type: "string",
          description: "New description (optional)",
        },
        location: {
          type: "string",
          description: "New location (optional)",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Delete a calendar event by ID.",
    input_schema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "The calendar event ID to delete",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "read_project_file",
    description:
      "Read a file from the EA project (context/, projects/, decisions/, templates/, references/).",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            'Relative path from project root, e.g. "context/current-priorities.md"',
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "write_project_file",
    description:
      "Write or update a file in the EA project. Use for updating priorities, project status, etc.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Relative path from project root",
        },
        content: {
          type: "string",
          description: "Full file content to write",
        },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "list_project_files",
    description: "List files in a project directory.",
    input_schema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            'Directory to list, e.g. "projects/" or "context/"',
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "triage_inbox",
    description:
      "Run email triage on Greg's inbox. Scans recent emails, classifies them as EA/Action, EA/FYI, or EA/Noise, and applies Gmail labels. Returns a summary.",
    input_schema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours back to scan (default 6)",
        },
      },
      required: [],
    },
  },
  {
    name: "apply_email_label",
    description:
      "Apply a Gmail label to a specific email. Use to reclassify emails (e.g., move from EA/Noise to EA/Action).",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID",
        },
        label_name: {
          type: "string",
          description: 'Label to apply, e.g. "EA/Action", "EA/FYI", "EA/Noise"',
        },
      },
      required: ["message_id", "label_name"],
    },
  },
  {
    name: "list_labels",
    description:
      "List all Gmail labels in Greg's account. Use this to see the full label inventory for cleanup or organization.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "remove_email_label",
    description:
      "Remove a Gmail label from a specific email. Use to reclassify or clean up label assignments.",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID",
        },
        label_name: {
          type: "string",
          description: "Label name to remove",
        },
      },
      required: ["message_id", "label_name"],
    },
  },
  {
    name: "delete_label",
    description:
      "Permanently delete a Gmail label. Does not delete the emails, just removes the label. Use for label cleanup.",
    input_schema: {
      type: "object",
      properties: {
        label_name: {
          type: "string",
          description: "The label name to delete",
        },
      },
      required: ["label_name"],
    },
  },
  {
    name: "learn_from_inbox",
    description:
      "Learn from Greg's email behavior. Checks recently starred/important emails to detect corrections to triage rules. Promotes or demotes senders based on patterns. Run this to update the triage profile based on how Greg interacts with his inbox.",
    input_schema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours back to scan for Greg's email actions (default 2)",
        },
      },
      required: [],
    },
  },
  {
    name: "upload_to_drive",
    description:
      "Upload a file to Google Drive. Creates a new file or updates an existing one with the same name in the specified folder.",
    input_schema: {
      type: "object",
      properties: {
        file_name: { type: "string", description: "Name for the file in Drive" },
        content: { type: "string", description: "File content to upload" },
        mime_type: { type: "string", description: 'MIME type (default "text/markdown")' },
        folder_id: { type: "string", description: "Google Drive folder ID to upload into (optional)" },
      },
      required: ["file_name", "content"],
    },
  },
  {
    name: "search_drive",
    description:
      "Search Google Drive for files by name or content. Returns file names, IDs, and links.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Drive search query (e.g. \"name contains \'recovery\'\")" },
        max_results: { type: "number", description: "Maximum results to return (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_drive_folder",
    description: "Find or create a Google Drive folder by name.",
    input_schema: {
      type: "object",
      properties: {
        folder_name: { type: "string", description: "Folder name" },
        parent_id: { type: "string", description: "Parent folder ID (optional, defaults to root)" },
      },
      required: ["folder_name"],
    },
  },
  {
    name: "read_drive_file",
    description:
      "Read the contents of a file from Google Drive by its file ID. Use search_drive first to find the file ID. Works with Google Docs, Sheets (as CSV), text files, PDFs, and Word docs.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Google Drive file ID" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "list_drive_folder",
    description:
      "List files in a Google Drive folder by folder ID. Use search_drive to find the folder ID first.",
    input_schema: {
      type: "object",
      properties: {
        folder_id: { type: "string", description: "The Google Drive folder ID" },
        max_results: { type: "number", description: "Maximum files to list (default 25)" },
      },
      required: ["folder_id"],
    },
  },
  {
    name: "backup_recovery_doc",
    description:
      "Upload the latest recovery-doc.md to Google Drive in the Claude EA Backups folder. Runs automatically daily at 6am CST, but can be triggered manually.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_pipeline",
    description:
      "Get the full deal pipeline summary. Shows all active deals grouped by stage with key dates, projected revenue, and next actions.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_deal",
    description:
      "Look up a specific deal by name. Returns all details: stage, market, rep, purchase price, projected gross, contract date, feasibility date, close date, priority, next action, and notes. Fuzzy matches on deal name.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string", description: "Deal name or partial name to search for" },
      },
      required: ["deal_name"],
    },
  },
  {
    name: "update_deal",
    description:
      "Update a field on a deal in the pipeline sheet. Use to change stage, dates, amounts, next actions, etc.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string", description: "Deal name or partial match" },
        field: { type: "string", description: "Column name to update (e.g. Stage, Close Date, Next Action, Notes)" },
        value: { type: "string", description: "New value for the field" },
      },
      required: ["deal_name", "field", "value"],
    },
  },
  {
    name: "log_decision",
    description:
      "Append a decision to the decision log (decisions/log.md). Use when Greg makes a meaningful business or operational decision.",
    input_schema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          description: "The decision that was made",
        },
        reasoning: { type: "string", description: "Why this decision was made" },
        context: {
          type: "string",
          description: "Relevant context (deal, project, etc)",
        },
      },
      required: ["decision", "reasoning", "context"],
    },
  },
];

// Tools available to team members (search Drive, check availability, read project files, pipeline)
// NO email access, NO writing, NO calendar details
const TEAM_TOOLS = [
  {
    name: "team_search_drive",
    description:
      "Search shared project files in Google Drive. Returns matching file names, links, types, and last modified dates. Only searches within shared project folders.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term (file name or content to find)",
        },
        max_results: {
          type: "number",
          description: "Maximum results to return (default 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "team_list_drive_folder",
    description:
      "List files in a shared project folder on Google Drive. Use team_search_drive first to find folder IDs.",
    input_schema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description: "Google Drive folder ID to list",
        },
        max_results: {
          type: "number",
          description: "Maximum files to list (default 25)",
        },
      },
      required: ["folder_id"],
    },
  },
  {
    name: "team_read_drive_file",
    description:
      "Read the contents of a file from shared project folders on Google Drive. Use team_search_drive first to find the file ID.",
    input_schema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "The Google Drive file ID to read",
        },
      },
      required: ["file_id"],
    },
  },
  {
    name: "check_freebusy",
    description:
      "Check calendar availability for a date range. Returns busy/free time blocks only (no event titles, descriptions, or attendees). Use this to find open meeting times.",
    input_schema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description:
            "Start date/time in ISO 8601 format (e.g. 2026-03-12T09:00:00)",
        },
        end_date: {
          type: "string",
          description:
            "End date/time in ISO 8601 format (max 7 days from start)",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "read_project_file",
    description:
      "Read a file from the EA project (context/, projects/, decisions/, templates/, references/).",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            'Relative path from project root, e.g. "context/current-priorities.md"',
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "list_project_files",
    description: "List files in a project directory.",
    input_schema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            'Directory to list, e.g. "projects/" or "context/"',
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "get_pipeline",
    description:
      "Get the full deal pipeline summary. Shows all active deals grouped by stage with key dates, projected revenue, and next actions.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_deal",
    description:
      "Look up a specific deal by name. Returns all details: stage, market, rep, purchase price, projected gross, contract date, feasibility date, close date, priority, next action, and notes. Fuzzy matches on deal name.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: {
          type: "string",
          description: "Deal name or partial name to search for",
        },
      },
      required: ["deal_name"],
    },
  },
];

// Tools available to all users (no sensitive data access)
const PUBLIC_TOOLS = [
  {
    name: "read_project_file",
    description:
      "Read a file from the EA project (context/, projects/, decisions/, templates/, references/).",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            'Relative path from project root, e.g. "context/current-priorities.md"',
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "list_project_files",
    description: "List files in a project directory.",
    input_schema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            'Directory to list, e.g. "projects/" or "context/"',
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "get_pipeline",
    description:
      "Get the full deal pipeline summary. Shows all active deals grouped by stage with key dates, projected revenue, and next actions.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_deal",
    description:
      "Look up a specific deal by name. Returns all details: stage, market, rep, purchase price, projected gross, contract date, feasibility date, close date, priority, next action, and notes. Fuzzy matches on deal name.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string", description: "Deal name or partial name to search for" },
      },
      required: ["deal_name"],
    },
  },
];

module.exports = { OWNER_TOOLS, TEAM_TOOLS, PUBLIC_TOOLS };
