#!/bin/bash
set -e
cd /tmp
echo 'Downloading bridge...'
curl -sL https://raw.githubusercontent.com/Aelshi-nui/consumet-bridge/main/server.js -o server.js
cat > package.json <<'PKGJSON'
{
  "type": "module",
  "dependencies": {
    "express": "4.21.2",
    "playwright-extra": "4.3.6",
    "puppeteer-extra-plugin-stealth": "2.11.2"
  }
}
PKGJSON
echo 'Installing deps...'
npm install 2>&1 | tail -3
echo 'Starting bridge...'
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
node server.js
