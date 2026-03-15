#!/bin/bash
# Setup Caddy reverse proxy for Mission Control dashboard
# Run on VPS: bash /opt/claude-ea/scripts/setup-caddy.sh
#
# Prerequisites:
# 1. DNS A record for your domain pointing to this server's IP
# 2. Port 80 and 443 open in firewall
#
# Usage: DOMAIN=mc.gfdevllc.com bash setup-caddy.sh

set -euo pipefail

DOMAIN="${DOMAIN:-mc.gfdevllc.com}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3001}"

echo "Setting up Caddy for ${DOMAIN} -> localhost:${DASHBOARD_PORT}"

# Install Caddy
if ! command -v caddy &> /dev/null; then
  echo "Installing Caddy..."
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  echo "Caddy installed."
else
  echo "Caddy already installed."
fi

# Open firewall ports for HTTP/HTTPS
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true

# Write Caddyfile
cat > /etc/caddy/Caddyfile << CADDYEOF
${DOMAIN} {
    reverse_proxy localhost:${DASHBOARD_PORT}

    # WebSocket support for SSE
    @sse path /api/stream
    reverse_proxy @sse localhost:${DASHBOARD_PORT} {
        flush_interval -1
        transport http {
            read_timeout 0
        }
    }

    # PubSub webhook endpoints (no TLS client auth needed)
    @webhook path /api/webhook/*
    reverse_proxy @webhook localhost:${DASHBOARD_PORT}

    # Security headers
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }

    # Logging
    log {
        output file /var/log/caddy/access.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
CADDYEOF

# Create log directory
mkdir -p /var/log/caddy

# Enable and start Caddy
systemctl enable caddy
systemctl restart caddy

echo ""
echo "Caddy is running. HTTPS will be provisioned automatically."
echo "Dashboard: https://${DOMAIN}"
echo ""
echo "Next steps:"
echo "1. Update DASHBOARD_URL in /opt/claude-ea/.env:"
echo "   DASHBOARD_URL=https://${DOMAIN}"
echo "2. Restart the bot: pm2 restart claude-ea --update-env"
echo "3. Test: curl -I https://${DOMAIN}"
