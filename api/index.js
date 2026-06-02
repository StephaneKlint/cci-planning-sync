export default function handler(req, res) {
  console.log('[Handler] Received request:', req.method, req.path);

  try {
    if (req.path === '/health') {
      return res.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    if (req.path === '/') {
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>CCI Planning - Ready!</title>
            <style>
              body { font-family: sans-serif; padding: 40px; text-align: center; }
              h1 { color: #10b981; }
              p { color: #666; margin: 20px 0; }
              code { background: #f0f0f0; padding: 10px; display: block; margin: 20px 0; }
            </style>
          </head>
          <body>
            <h1>✅ CCI Planning Server is Running!</h1>
            <p>WebSocket + PostgreSQL app deployed on Vercel</p>
            <code>https://cci-planning-sync.vercel.app</code>
            <p>Status: <strong>LIVE</strong></p>
          </body>
        </html>
      `);
    }

    res.status(404).send('Not Found');
  } catch (err) {
    console.error('[Handler] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
