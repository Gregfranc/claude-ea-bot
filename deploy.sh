#!/bin/bash
# Auto-deploy script triggered by GitHub webhook
cd /opt/claude-ea || exit 1

# Preserve runtime data files before pull (gitignored files can be deleted by git rm --cached)
mkdir -p /tmp/claude-ea-data-backup
for f in triage-profile.json triage-corrections.json triage-resolved.json meeting-log.json rag-sync-state.json; do
  [ -f "data/$f" ] && cp "data/$f" "/tmp/claude-ea-data-backup/$f"
done

git pull origin main
npm install --production

# Restore runtime data files if they were deleted by pull
mkdir -p data
for f in triage-profile.json triage-corrections.json triage-resolved.json meeting-log.json rag-sync-state.json; do
  if [ ! -f "data/$f" ] && [ -f "/tmp/claude-ea-data-backup/$f" ]; then
    cp "/tmp/claude-ea-data-backup/$f" "data/$f"
    echo "Restored data/$f"
  fi
done

# One-time migration: add mixed_senders to triage-profile.json if missing
if [ -f "data/triage-profile.json" ]; then
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('data/triage-profile.json','utf-8'));
    if (!p.mixed_senders) {
      p.mixed_senders = [
        {sender:'upwork',star_if:'messages about active contracts, hire requests, or payment issues',noise_if:'marketing, tips, promotions, talent suggestions'},
        {sender:'american airlines',star_if:'reservation confirmations, boarding passes, flight changes, cancellations, gate changes',noise_if:'promotions, credit card offers, mileage deals, AAdvantage marketing'},
        {sender:'united',star_if:'reservation confirmations, boarding passes, flight changes, cancellations',noise_if:'promotions, credit card offers, mileage marketing'},
        {sender:'delta',star_if:'reservation confirmations, boarding passes, flight changes, cancellations',noise_if:'promotions, credit card offers, skymiles marketing'},
        {sender:'experian',star_if:'fraud alerts, credit monitoring alerts, identity theft notifications',noise_if:'credit card offers, score updates, marketing'},
        {sender:'citi',star_if:'fraud alerts, payment confirmations, account security',noise_if:'credit card offers, travel promotions, marketing'},
        {sender:'wells fargo',star_if:'fraud alerts, payment confirmations, account security, wire transfers',noise_if:'marketing, credit offers, promotions'},
        {sender:'wise',star_if:'transfer confirmations, payment received, verification needed',noise_if:'rate alerts, marketing, referral promotions'}
      ];
      // Remove mixed senders from noise_senders
      const mixedNames = p.mixed_senders.map(m => m.sender);
      p.noise_senders = (p.noise_senders||[]).filter(s => !mixedNames.some(m => s.includes(m) || m.includes(s)));
      fs.writeFileSync('data/triage-profile.json', JSON.stringify(p, null, 2));
      console.log('Migration: added mixed_senders to triage-profile.json');
    }
  "
fi

# Also pull the EA project repo (templates, context files)
if [ -d /opt/claude-ea-project ]; then
  echo "Pulling EA project repo..."
  cd /opt/claude-ea-project && git pull origin main 2>&1 || echo "EA project pull failed (non-fatal)"
  cd /opt/claude-ea
fi

pm2 restart claude-ea
echo "Deploy complete at $(date)"
