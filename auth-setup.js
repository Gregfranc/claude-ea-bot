// One-time OAuth setup script for Google APIs (Gmail + Calendar)
// Run this once: node auth-setup.js
// It opens a browser, you authorize, and it captures the token automatically.

require("dotenv").config();
const { google } = require("googleapis");
const http = require("http");
const url = require("url");
const { exec } = require("child_process");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
];

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("\nMissing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
    process.exit(1);
  }

  // Desktop apps can use localhost redirect
  const REDIRECT_URI = "http://localhost:3000/oauth2callback";

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === "/oauth2callback") {
      const code = parsedUrl.query.code;

      if (!code) {
        res.end("No authorization code received. Try again.");
        server.close();
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h2>Authorization successful!</h2><p>You can close this tab and go back to Claude Code.</p>"
        );

        console.log("\n--- SUCCESS ---\n");
        console.log("Add this to your .env file:\n");
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log("\nThen start the bot with: npm start");
      } catch (err) {
        res.end("Error exchanging code for tokens: " + err.message);
        console.error("Token exchange error:", err.message);
      }

      server.close();
    }
  });

  server.listen(3000, () => {
    console.log("\n=== Google OAuth Setup ===\n");
    console.log("Opening browser. Sign in with greg@gfdevllc.com and authorize.\n");
    console.log("If the browser doesn't open, copy this URL:\n");
    console.log(authUrl);
    console.log("\nWaiting...");
    exec(`open "${authUrl}"`);
  });
}

main();
