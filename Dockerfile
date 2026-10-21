FROM mcr.microsoft.com/playwright:v1.51.0-noble
ENV NODE_ENV=production PORT=8080 HEADLESS=true
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
RUN mkdir -p /app/browser-profile /app/data && chown -R pwuser:pwuser /app
USER pwuser
EXPOSE 8080
CMD ["npm", "start"]
