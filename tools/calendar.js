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

async function listEvents(daysAhead = 7, calendarId = "primary") {
  const calendar = getCalendar();
  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + daysAhead);

  const res = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const events = (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || "(no title)",
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date,
    location: e.location || "",
    description: e.description ? e.description.substring(0, 200) : "",
    attendees: (e.attendees || []).map((a) => a.email),
  }));

  return {
    count: events.length,
    events,
    range: `${now.toLocaleDateString()} to ${future.toLocaleDateString()}`,
  };
}

async function createEvent(
  summary,
  startDateTime,
  endDateTime,
  { description, location, attendees, calendarId = "primary" } = {}
) {
  const calendar = getCalendar();

  const event = {
    summary,
    start: { dateTime: startDateTime, timeZone: "America/Mexico_City" },
    end: { dateTime: endDateTime, timeZone: "America/Mexico_City" },
  };

  if (description) event.description = description;
  if (location) event.location = location;
  if (attendees) {
    event.attendees = attendees.map((email) => ({ email }));
  }

  const res = await calendar.events.insert({
    calendarId,
    requestBody: event,
    sendUpdates: attendees ? "all" : "none",
  });

  return {
    id: res.data.id,
    summary: res.data.summary,
    start: res.data.start.dateTime || res.data.start.date,
    link: res.data.htmlLink,
    message: `Event created: "${summary}" on ${res.data.start.dateTime || res.data.start.date}`,
  };
}

async function updateEvent(
  eventId,
  updates,
  { calendarId = "primary" } = {}
) {
  const calendar = getCalendar();

  const existing = await calendar.events.get({
    calendarId,
    eventId,
  });

  const event = existing.data;

  if (updates.summary) event.summary = updates.summary;
  if (updates.description) event.description = updates.description;
  if (updates.location) event.location = updates.location;
  if (updates.startDateTime) {
    event.start = {
      dateTime: updates.startDateTime,
      timeZone: "America/Mexico_City",
    };
  }
  if (updates.endDateTime) {
    event.end = {
      dateTime: updates.endDateTime,
      timeZone: "America/Mexico_City",
    };
  }

  const res = await calendar.events.update({
    calendarId,
    eventId,
    requestBody: event,
  });

  return {
    id: res.data.id,
    summary: res.data.summary,
    start: res.data.start.dateTime || res.data.start.date,
    message: `Event updated: "${res.data.summary}"`,
  };
}

async function deleteEvent(eventId, { calendarId = "primary" } = {}) {
  const calendar = getCalendar();
  await calendar.events.delete({
    calendarId,
    eventId,
  });

  return { message: `Event ${eventId} deleted.` };
}

module.exports = { listEvents, createEvent, updateEvent, deleteEvent };
