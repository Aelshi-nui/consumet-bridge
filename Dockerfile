FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

# Playwright is already installed in the base image at /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY server.js ./

EXPOSE 7860
CMD ["node", "server.js"]
