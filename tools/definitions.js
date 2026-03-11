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
];

module.exports = { OWNER_TOOLS, PUBLIC_TOOLS };
