// Usage tracking: daily per-user tool call counter
// Stored in data/usage.json, rotates after 30 days

const fs = require("fs").promises;
const path = require("path");

const USAGE_FILE = path.join(__dirname, "../data/usage.json");
const MAX_DAYS = 30;

async function loadUsage() {
  try {
    const data = await fs.readFile(USAGE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveUsage(data) {
  await fs.writeFile(USAGE_FILE, JSON.stringify(data, null, 2));
}

function getToday() {
  return new Date().toISOString().split("T")[0];
}

async function trackUsage(userId, toolName) {
  const data = await loadUsage();
  const today = getToday();

  if (!data[today]) data[today] = {};
  if (!data[today][userId]) data[today][userId] = { tool_calls: 0 };

  data[today][userId].tool_calls++;
  data[today][userId][toolName] = (data[today][userId][toolName] || 0) + 1;

  // Prune old days
  const dates = Object.keys(data).sort();
  while (dates.length > MAX_DAYS) {
    delete data[dates.shift()];
  }

  await saveUsage(data);
}

async function getUsageSummary(userId, days = 1) {
  const data = await loadUsage();
  const summary = { total_calls: 0, by_tool: {} };

  const dates = Object.keys(data).sort().slice(-days);
  for (const date of dates) {
    const userDay = data[date]?.[userId];
    if (!userDay) continue;
    summary.total_calls += userDay.tool_calls || 0;
    for (const [key, val] of Object.entries(userDay)) {
      if (key !== "tool_calls") {
        summary.by_tool[key] = (summary.by_tool[key] || 0) + val;
      }
    }
  }

  return summary;
}

async function getDailyReport() {
  const data = await loadUsage();
  const today = getToday();
  return data[today] || {};
}

module.exports = { trackUsage, getUsageSummary, getDailyReport };
