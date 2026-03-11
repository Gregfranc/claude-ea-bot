require("dotenv").config();
const { google } = require("googleapis");

function getAuthedClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost:3000/oauth2callback"
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

async function archiveOldEmails() {
  const gmail = getAuthedClient();
  const query = "in:inbox before:2026/01/01";
  let archived = 0;
  let skipped = 0;
  let pageToken = undefined;

  console.log("Searching for inbox emails older than January 1, 2026...");

  while (true) {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) break;

    console.log(`Found ${messages.length} emails in this batch, archiving...`);

    for (const msg of messages) {
      try {
        await gmail.users.messages.modify({
          userId: "me",
          id: msg.id,
          requestBody: { removeLabelIds: ["INBOX"] },
        });
        archived++;
        if (archived % 50 === 0) console.log(`  Archived ${archived} so far...`);
      } catch (err) {
        skipped++;
      }
    }

    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }

  console.log(`Done. Archived ${archived} emails, skipped ${skipped}.`);
}

archiveOldEmails().catch(console.error);
