#!/bin/bash
set -e
cd /tmp

echo 'Downloading bridge...'
curl -sL https://raw.githubusercontent.com/Aelshi-nui/consumet-bridge/main/server.js -o server.js

echo '{"type":"module","name":"bridge","version":"1.0.0"}' > package.json

echo 'Installing deps...'
npm install express@4.21.2 playwright-core@1.48.2 playwright-extra@4.3.6 puppeteer-extra-plugin-stealth@2.11.2 2>&1 | tail -3

echo 'Checking playwright-core...'
ls /tmp/node_modules/playwright-core/package.json 2>/dev/null && echo 'playwright-core OK' || echo 'playwright-core MISSING'

echo 'Starting bridge...'
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
node server.js
