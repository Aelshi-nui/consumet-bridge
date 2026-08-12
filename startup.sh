#!/bin/bash
echo BUST=$BUST
mkdir -p /app
cd /app

echo Downloading...
curl -sLf https://raw.githubusercontent.com/Aelshi-nui/consumet-bridge/main/server.js -o server.js
echo Type check: $(head -1 server.js)

echo Installing...
npm install --prefix /app express@4.21.2 playwright-core@1.48.2 playwright-extra@4.3.6 puppeteer-extra-plugin-stealth@2.11.2
echo installed: $(ls /app/node_modules | head -5)

echo Starting...
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
export NODE_PATH=/app/node_modules
node server.js
