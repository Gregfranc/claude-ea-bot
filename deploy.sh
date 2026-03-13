#!/bin/bash
# Auto-deploy script triggered by GitHub webhook
cd /opt/claude-ea || exit 1

# Preserve runtime data files before pull (gitignored files can be deleted by git rm --cached)
mkdir -p /tmp/claude-ea-data-backup
for f in triage-profile.json triage-corrections.json triage-resolved.json meeting-log.json; do
  [ -f "data/$f" ] && cp "data/$f" "/tmp/claude-ea-data-backup/$f"
done

git pull origin main
npm install --production

# Restore runtime data files if they were deleted by pull
mkdir -p data
for f in triage-profile.json triage-corrections.json triage-resolved.json meeting-log.json; do
  if [ ! -f "data/$f" ] && [ -f "/tmp/claude-ea-data-backup/$f" ]; then
    cp "/tmp/claude-ea-data-backup/$f" "data/$f"
    echo "Restored data/$f"
  fi
done

pm2 restart claude-ea
echo "Deploy complete at $(date)"
