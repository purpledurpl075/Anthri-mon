#!/bin/bash
set -euo pipefail

DIST_DIR="/home/poly/Anthri-mon/frontend/dashboard/dist"
API_SERVICE="/etc/systemd/system/anthrimon-api.service"
NGINX_CONF="/etc/nginx/sites-available/anthrimon"

echo "==> Installing nginx..."
apt-get install -y nginx

echo "==> Writing nginx site config..."
cat > "$NGINX_CONF" << 'NGINX'
server {
    listen 80 default_server;
    server_name _;

    root /home/poly/Anthri-mon/frontend/dashboard/dist;
    index index.html;

    # SPA — all non-file routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Immutable static assets — cache for 1 year
    location ~* \.(?:js|css|woff2?|ttf|eot|svg|png|jpg|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API proxy → uvicorn
    location /api/ {
        proxy_pass         http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE / long-poll — disable buffering, extend timeout
        proxy_set_header   Connection        '';
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
NGINX

echo "==> Enabling site and removing default..."
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/anthrimon
rm -f /etc/nginx/sites-enabled/default

echo "==> Setting dist directory permissions for nginx..."
chmod o+x /home/poly \
           /home/poly/Anthri-mon \
           /home/poly/Anthri-mon/frontend \
           /home/poly/Anthri-mon/frontend/dashboard \
           "$DIST_DIR"

echo "==> Testing nginx config..."
nginx -t

echo "==> Enabling and starting nginx..."
systemctl enable --now nginx

echo "==> Locking uvicorn to localhost..."
sed -i 's/--host 0\.0\.0\.0/--host 127.0.0.1/' "$API_SERVICE"
systemctl daemon-reload
systemctl restart anthrimon-api

echo ""
echo "Done. Anthrimon is now at http://$(hostname -I | awk '{print $1}')/"
