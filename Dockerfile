FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production
ENV PORT=8080
ENV HEADLESS=false
ENV DISPLAY=:99

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       xvfb \
       x11vnc \
       novnc \
       websockify \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./
COPY start.sh ./

RUN mkdir -p /app/browser-profile /app/data \
    && chmod +x /app/start.sh \
    && chown -R pwuser:pwuser /app

EXPOSE 8080 6080

USER pwuser

CMD ["/app/start.sh"]
