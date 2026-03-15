#!/bin/bash
# Setup Gmail PubSub for real-time email notifications
# Run locally or on VPS with gcloud CLI installed
#
# Prerequisites:
# 1. gcloud CLI installed and authenticated
# 2. HTTPS domain configured (Caddy running)
# 3. Cloud Pub/Sub API enabled on project
#
# Usage: DOMAIN=mc.gfdevllc.com bash setup-pubsub.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-claude-ea-489812}"
TOPIC_NAME="${TOPIC_NAME:-gmail-push}"
SUB_NAME="${SUB_NAME:-gmail-push-sub}"
DOMAIN="${DOMAIN:-mc.gfdevllc.com}"
WEBHOOK_URL="https://${DOMAIN}/api/webhook/gmail"

echo "Setting up Gmail PubSub for project: ${PROJECT_ID}"

# Install gcloud if not present
if ! command -v gcloud &> /dev/null; then
  echo "ERROR: gcloud CLI not installed."
  echo "Install: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Set project
gcloud config set project "${PROJECT_ID}"

# Enable Pub/Sub API
echo "Enabling Pub/Sub API..."
gcloud services enable pubsub.googleapis.com

# Create topic
echo "Creating topic: ${TOPIC_NAME}..."
gcloud pubsub topics create "${TOPIC_NAME}" 2>/dev/null || echo "Topic already exists."

# Grant Gmail API permission to publish to this topic
echo "Granting Gmail publish permission..."
gcloud pubsub topics add-iam-policy-binding "${TOPIC_NAME}" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# Create push subscription pointing to our webhook
echo "Creating push subscription: ${SUB_NAME}..."
gcloud pubsub subscriptions create "${SUB_NAME}" \
  --topic="${TOPIC_NAME}" \
  --push-endpoint="${WEBHOOK_URL}" \
  --ack-deadline=30 \
  --message-retention-duration=1h \
  2>/dev/null || echo "Subscription already exists. Updating..."

# Update subscription if it already exists
gcloud pubsub subscriptions update "${SUB_NAME}" \
  --push-endpoint="${WEBHOOK_URL}" \
  2>/dev/null || true

FULL_TOPIC="projects/${PROJECT_ID}/topics/${TOPIC_NAME}"

echo ""
echo "PubSub setup complete."
echo ""
echo "Topic: ${FULL_TOPIC}"
echo "Subscription: ${SUB_NAME}"
echo "Webhook: ${WEBHOOK_URL}"
echo ""
echo "Next steps:"
echo "1. Add to /opt/claude-ea/.env:"
echo "   GMAIL_PUBSUB_TOPIC=${FULL_TOPIC}"
echo "2. Restart the bot: pm2 restart claude-ea --update-env"
echo "3. The bot will auto-register Gmail watch on next startup."
