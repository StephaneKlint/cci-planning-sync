const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>CCI Planning - Ready!</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 40px;
            text-align: center;
            background: #f5f5f5;
          }
          h1 { color: #10b981; margin: 0; }
          p { color: #666; margin: 20px 0; }
          code {
            background: #f0f0f0;
            padding: 10px;
            display: block;
            margin: 20px 0;
            border-radius: 4px;
            font-family: monospace;
          }
          .status { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        </style>
      </head>
      <body>
        <div class="status">
          <h1>✅ CCI Planning Server is Ready!</h1>
          <p>WebSocket + PostgreSQL app deployed on Vercel</p>
          <code>https://cci-planning-sync.vercel.app</code>
          <p style="margin-top: 30px; font-size: 14px; color: #999;">
            Status: <strong style="color: #10b981;">LIVE</strong><br>
            Next: Connect your planning app via WebSocket
          </p>
        </div>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;
