// Tool definitions for Claude API function calling
// These define what the agent can do

const OWNER_TOOLS = [
  {
    name: "search_emails",
    description: "Search Gmail. Supports Gmail search syntax.",
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
    description: "Read full email content by message ID.",
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
    description: "Create Gmail draft (does not send).",
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
    description: "Send email immediately. Prefer create_draft unless Greg says to send.",
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
    description: "Reply to email thread. Sends immediately.",
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
    description: "List upcoming calendar events.",
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
    description: "Create calendar event. ISO 8601 times.",
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
    description: "Update calendar event by ID.",
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
    description: "Read a file from the EA project.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: 'Relative path, e.g. "context/current-priorities.md"',
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "write_project_file",
    description: "Write/update a project file.",
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
    description: "Run email triage on inbox.",
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
    description: "Apply a Gmail label to an email.",
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
    description: "List all Gmail labels.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "remove_email_label",
    description: "Remove a Gmail label from an email.",
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
    description: "Delete a Gmail label. Emails are kept.",
    input_schema: {
      type: "object",
      properties: {
        label_name: { type: "string", description: "Label name to delete" },
      },
      required: ["label_name"],
    },
  },
  {
    name: "learn_from_inbox",
    description: "Update triage profile from Greg's recent starring/labeling.",
    input_schema: {
      type: "object",
      properties: {
        hours_back: { type: "number", description: "Hours back to scan (default 2)" },
      },
      required: [],
    },
  },
  {
    name: "apply_triage_correction",
    description: "Apply a triage correction. Mark a sender as 'star' (important) or 'noise' (auto-archive). Use when Greg says a sender should be starred or noise.",
    input_schema: {
      type: "object",
      properties: {
        sender: { type: "string", description: "Sender name or pattern (e.g. 'upwork', 'brian chaplin')" },
        action: { type: "string", enum: ["star", "noise"], description: "'star' to flag as important, 'noise' to auto-archive" },
      },
      required: ["sender", "action"],
    },
  },
  {
    name: "upload_to_drive",
    description: "Upload file to Google Drive. Updates if same name exists.",
    input_schema: {
      type: "object",
      properties: {
        file_name: { type: "string", description: "File name in Drive" },
        content: { type: "string", description: "File content" },
        mime_type: { type: "string", description: "MIME type (default text/markdown)" },
        folder_id: { type: "string", description: "Target folder ID (optional)" },
      },
      required: ["file_name", "content"],
    },
  },
  {
    name: "search_drive",
    description: "Search Google Drive files by name/content.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Drive search query" },
        max_results: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_drive_folder",
    description: "Find or create a Drive folder.",
    input_schema: {
      type: "object",
      properties: {
        folder_name: { type: "string", description: "Folder name" },
        parent_id: { type: "string", description: "Parent folder ID (optional)" },
      },
      required: ["folder_name"],
    },
  },
  {
    name: "read_drive_file",
    description: "Read file from Drive by ID. Works with Docs, Sheets, PDFs, Word.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Drive file ID" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "list_drive_folder",
    description: "List files in a Drive folder by ID.",
    input_schema: {
      type: "object",
      properties: {
        folder_id: { type: "string", description: "Drive folder ID" },
        max_results: { type: "number", description: "Max files (default 25)" },
      },
      required: ["folder_id"],
    },
  },
  {
    name: "backup_recovery_doc",
    description: "Upload recovery-doc.md to Drive backups folder.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_pipeline",
    description: "Get deal pipeline summary: all deals by stage with dates and revenue.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_deal",
    description: "Look up a deal by name. Fuzzy match.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string", description: "Deal name or partial match" },
      },
      required: ["deal_name"],
    },
  },
  {
    name: "update_deal",
    description: "Update a deal field in the pipeline sheet.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string", description: "Deal name or partial match" },
        field: { type: "string", description: "Column name (e.g. Stage, Close Date, Next Action)" },
        value: { type: "string", description: "New value" },
      },
      required: ["deal_name", "field", "value"],
    },
  },
  {
    name: "process_transcript",
    description: "Process meeting transcript: summarize, classify, save to Drive.",
    input_schema: {
      type: "object",
      properties: {
        file_ref: { type: "string", description: "Uploaded file reference ID" },
        transcript_text: { type: "string", description: "Raw transcript text (if no file_ref)" },
        file_name: { type: "string", description: "Original file name (optional)" },
        source: { type: "string", description: "Source: Notta, Google Meet, Read AI, Zoom, Teams, Other" },
      },
      required: [],
    },
  },
  {
    name: "search_meeting_notes",
    description: "Search past meeting notes by keyword. Searches titles, summaries, projects, dates.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (e.g. 'drainage', 'Knox', 'Traditions North', '2026-03')" },
      },
      required: ["query"],
    },
  },
  {
    name: "backfill_meeting_notes",
    description: "One-time scan: process 6 months of meeting report emails + all Gemini Notes from Drive into the tracker sheet. Takes several minutes.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "read_spreadsheet",
    description: "Read Google Sheet data by URL or ID.",
    input_schema: {
      type: "object",
      properties: {
        spreadsheet: { type: "string", description: "Sheets URL or spreadsheet ID" },
        range: { type: "string", description: "Cell range (e.g. Sheet1!A1:F50). Omit for full sheet." },
      },
      required: ["spreadsheet"],
    },
  },
  {
    name: "write_spreadsheet",
    description: "Write cells to a Google Sheet. Overwrites specified range.",
    input_schema: {
      type: "object",
      properties: {
        spreadsheet: { type: "string", description: "Sheets URL or spreadsheet ID" },
        range: { type: "string", description: "Cell range to write" },
        values: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "2D array of values (rows)",
        },
      },
      required: ["spreadsheet", "range", "values"],
    },
  },
  {
    name: "append_spreadsheet",
    description: "Append rows to end of a Google Sheet.",
    input_schema: {
      type: "object",
      properties: {
        spreadsheet: { type: "string", description: "Sheets URL or spreadsheet ID" },
        range: { type: "string", description: "Column range to append to" },
        values: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "2D array of rows to append",
        },
      },
      required: ["spreadsheet", "range", "values"],
    },
  },
  {
    name: "get_spreadsheet_info",
    description: "Get Sheet metadata: title, tab names, dimensions.",
    input_schema: {
      type: "object",
      properties: {
        spreadsheet: { type: "string", description: "Sheets URL or spreadsheet ID" },
      },
      required: ["spreadsheet"],
    },
  },
  {
    name: "log_decision",
    description: "Log a business decision to decisions/log.md.",
    input_schema: {
      type: "object",
      properties: {
        decision: { type: "string", description: "The decision" },
        reasoning: { type: "string", description: "Why" },
        context: { type: "string", description: "Deal/project context" },
      },
      required: ["decision", "reasoning", "context"],
    },
  },
  // --- Contract Drafting Tools ---
  {
    name: "search_precedent",
    description: "Search Drive for past contracts/amendments as precedent before drafting.",
    input_schema: {
      type: "object",
      properties: {
        deal_type: { type: "string", description: "Type: purchase-agreement, amendment, extension, assignment, lot-sale, option, earnest-money" },
        market: { type: "string", description: "Market: Idaho, Nevada, Washington, Oregon, California" },
        keywords: { type: "string", description: "Search keywords (property/party name)" },
      },
      required: [],
    },
  },
  {
    name: "list_contract_templates",
    description: "List available contract templates.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "read_contract_template",
    description: "Read a contract template by name.",
    input_schema: {
      type: "object",
      properties: {
        template_name: { type: "string", description: "Template name (no .md extension)" },
      },
      required: ["template_name"],
    },
  },
  {
    name: "generate_contract_doc",
    description: "Generate .docx contract and upload to Drive. Date-prefixed filename.",
    input_schema: {
      type: "object",
      properties: {
        contract_text: { type: "string", description: "Full contract text. UPPERCASE headers, numbered sections, ___ for signature lines." },
        file_name: { type: "string", description: "File name (no date prefix or .docx)" },
        doc_type: { type: "string", description: "Type: purchase-agreement, amendment, extension, assignment, lot-sale, option, earnest-money" },
        deal_name: { type: "string", description: "Deal name for subfolder (optional)" },
      },
      required: ["contract_text"],
    },
  },
];

// Team tools: Drive search, availability, project files, pipeline. No email/calendar details.
const TEAM_TOOLS = [
  {
    name: "search_meeting_notes",
    description: "Search past meeting notes by keyword. Only shows notes marked as Public.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (e.g. 'drainage', 'deal review')" },
      },
      required: ["query"],
    },
  },
  {
    name: "team_search_drive",
    description: "Search shared Drive files.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term" },
        max_results: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "team_list_drive_folder",
    description: "List files in a shared Drive folder.",
    input_schema: {
      type: "object",
      properties: {
        folder_id: { type: "string", description: "Drive folder ID" },
        max_results: { type: "number", description: "Max files (default 25)" },
      },
      required: ["folder_id"],
    },
  },
  {
    name: "team_read_drive_file",
    description: "Read a shared Drive file by ID.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Drive file ID" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "check_freebusy",
    description: "Check calendar availability. Returns busy/free blocks only.",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start ISO 8601 datetime" },
        end_date: { type: "string", description: "End ISO 8601 datetime (max 7 days)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "read_project_file",
    description: "Read a file from the EA project.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Relative path from project root" },
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
        directory: { type: "string", description: "Directory to list" },
      },
      required: ["directory"],
    },
  },
  {
    name: "get_pipeline",
    description: "Get deal pipeline summary.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_deal",
    description: "Look up a deal by name. Fuzzy match.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string", description: "Deal name or partial match" },
      },
      required: ["deal_name"],
    },
  },
];

// Public tools: no sensitive data access
const PUBLIC_TOOLS = [
  {
    name: "read_project_file",
    description: "Read a file from the EA project.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Relative path from project root" },
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
        directory: { type: "string", description: "Directory to list" },
      },
      required: ["directory"],
    },
  },
  {
    name: "get_pipeline",
    description: "Get deal pipeline summary.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "lookup_deal",
    description: "Look up a deal by name. Fuzzy match.",
    input_schema: {
      type: "object",
      properties: {
        deal_name: { type: "string", description: "Deal name or partial match" },
      },
      required: ["deal_name"],
    },
  },
];

module.exports = { OWNER_TOOLS, TEAM_TOOLS, PUBLIC_TOOLS };
