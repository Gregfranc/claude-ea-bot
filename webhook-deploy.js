const http = require("http");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = 9000;
const SECRET = process.env.WEBHOOK_SECRET;
const DEPLOY_SCRIPT = "/opt/claude-ea/deploy.sh";

if (!SECRET) {
  console.error("[Webhook] WEBHOOK_SECRET not set in .env");
  process.exit(1);
}

function verifySignature(payload, signature) {
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/deploy") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(body, sig)) {
      console.log("[Webhook] Invalid signature, rejecting");
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let event;
    try {
      event = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Bad JSON");
      return;
    }

    const ref = event.ref || "";
    if (ref !== "refs/heads/main") {
      console.log(`[Webhook] Push to ${ref}, ignoring (only deploy main)`);
      res.writeHead(200);
      res.end("Ignored (not main)");
      return;
    }

    console.log(`[Webhook] Push to main by ${event.pusher?.name || "unknown"}, deploying...`);
    res.writeHead(200);
    res.end("Deploying");

    execFile("bash", [DEPLOY_SCRIPT], (err, stdout, stderr) => {
      if (err) {
        console.error("[Webhook] Deploy failed:", err.message);
        console.error(stderr);
      } else {
        console.log("[Webhook] Deploy complete:", stdout.trim());
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`[Webhook] Listening on port ${PORT}`);
});
