// Calendar freebusy tool
// Returns only busy/free time blocks. No event titles, descriptions, or attendees.

const { google } = require("googleapis");

function getAuthedClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
  auth.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return auth;
}

function getCalendar() {
  return google.calendar({ version: "v3", auth: getAuthedClient() });
}

async function checkFreeBusy(startDate, endDate, calendarId = "primary") {
  const calendar = getCalendar();

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Validate range
  const diffDays = (end - start) / (1000 * 60 * 60 * 24);
  if (diffDays > 7) {
    return { error: "Time range limited to 7 days max." };
  }
  if (end <= start) {
    return { error: "End date must be after start date." };
  }

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busyBlocks = res.data.calendars[calendarId]?.busy || [];

  // Compute free blocks from the gaps between busy blocks
  const freeBlocks = [];
  let current = new Date(start);

  for (const busy of busyBlocks) {
    const busyStart = new Date(busy.start);
    const busyEnd = new Date(busy.end);

    if (current < busyStart) {
      freeBlocks.push({
        start: current.toISOString(),
        end: busyStart.toISOString(),
      });
    }
    current = busyEnd > current ? busyEnd : current;
  }

  if (current < end) {
    freeBlocks.push({
      start: current.toISOString(),
      end: end.toISOString(),
    });
  }

  return {
    range: { start: start.toISOString(), end: end.toISOString() },
    busy: busyBlocks.map((b) => ({ start: b.start, end: b.end })),
    free: freeBlocks,
    note: "Only busy/free time blocks shown. No event details are shared.",
  };
}

module.exports = { checkFreeBusy };
