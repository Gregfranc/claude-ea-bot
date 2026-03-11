const fs = require("fs").promises;
const path = require("path");
const { execFile } = require("child_process");

// On VPS: /opt/claude-ea-project (cloned private repo)
// Locally: parent of slack-bot directory
const PROJECT_ROOT = process.env.EA_PROJECT_PATH || path.resolve(__dirname, "../../");

const ALLOWED_PATHS = [
  "context/",
  "projects/",
  "decisions/",
  "templates/",
  "references/",
];

function isAllowedPath(filePath) {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  if (!resolved.startsWith(PROJECT_ROOT)) return false;
  const relative = path.relative(PROJECT_ROOT, resolved);
  return ALLOWED_PATHS.some((prefix) => relative.startsWith(prefix));
}

async function readProjectFile(filePath) {
  if (!isAllowedPath(filePath)) {
    return {
      error: `Access denied. Only files in these directories are accessible: ${ALLOWED_PATHS.join(", ")}`,
    };
  }

  // Pull latest before reading
  await gitPull();

  const fullPath = path.resolve(PROJECT_ROOT, filePath);
  try {
    const content = await fs.readFile(fullPath, "utf-8");
    return { path: filePath, content };
  } catch (err) {
    return { error: `Could not read ${filePath}: ${err.message}` };
  }
}

async function writeProjectFile(filePath, content) {
  if (!isAllowedPath(filePath)) {
    return {
      error: `Access denied. Only files in these directories are writable: ${ALLOWED_PATHS.join(", ")}`,
    };
  }

  const fullPath = path.resolve(PROJECT_ROOT, filePath);
  try {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    await gitSync(`Update ${filePath} via Slack bot`);
    return { path: filePath, message: `File updated and synced: ${filePath}` };
  } catch (err) {
    return { error: `Could not write ${filePath}: ${err.message}` };
  }
}

async function listProjectFiles(directory) {
  if (!isAllowedPath(directory)) {
    return {
      error: `Access denied. Only these directories are listable: ${ALLOWED_PATHS.join(", ")}`,
    };
  }

  const fullPath = path.resolve(PROJECT_ROOT, directory);
  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const files = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "directory" : "file",
    }));
    return { directory, files };
  } catch (err) {
    return { error: `Could not list ${directory}: ${err.message}` };
  }
}

async function appendToDecisionLog(decision, reasoning, context) {
  const logPath = path.resolve(PROJECT_ROOT, "decisions/log.md");
  const date = new Date().toISOString().split("T")[0];
  const entry = `\n[${date}] DECISION: ${decision} | REASONING: ${reasoning} | CONTEXT: ${context}\n`;

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, entry, "utf-8");
    await gitSync(`Log decision: ${decision.substring(0, 50)}`);
    return { message: `Decision logged and synced: ${decision}` };
  } catch (err) {
    return { error: `Could not append to decision log: ${err.message}` };
  }
}

function gitSync(message) {
  return new Promise((resolve) => {
    execFile("git", ["-C", PROJECT_ROOT, "add", "-A"], (err) => {
      if (err) { console.error("[Files] git add failed:", err.message); return resolve(false); }
      execFile("git", ["-C", PROJECT_ROOT, "commit", "-m", message], (err) => {
        if (err) { console.log("[Files] git commit skipped (no changes or error)"); return resolve(false); }
        execFile("git", ["-C", PROJECT_ROOT, "push"], (err) => {
          if (err) { console.error("[Files] git push failed:", err.message); return resolve(false); }
          console.log(`[Files] Synced to GitHub: ${message}`);
          resolve(true);
        });
      });
    });
  });
}

function gitPull() {
  return new Promise((resolve) => {
    execFile("git", ["-C", PROJECT_ROOT, "pull", "--ff-only"], (err) => {
      if (err) { console.error("[Files] git pull failed:", err.message); }
      resolve(!err);
    });
  });
}

module.exports = {
  readProjectFile,
  writeProjectFile,
  listProjectFiles,
  appendToDecisionLog,
  gitSync,
  gitPull,
};
