#!/bin/bash
# Auto-deploy script triggered by GitHub webhook
cd /opt/claude-ea || exit 1
git pull origin main
pm2 restart claude-ea
echo "Deploy complete at $(date)"
