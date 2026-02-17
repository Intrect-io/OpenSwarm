// ============================================
// Claude Swarm - Web Interface
// ============================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getChatHistory } from './discord.js';
import { getDateLocale } from './locale/index.js';

let server: ReturnType<typeof createServer> | null = null;

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VEGA - Chat History</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
    }
    header {
      background: #16213e;
      padding: 1rem 2rem;
      border-bottom: 1px solid #0f3460;
    }
    header h1 {
      font-size: 1.5rem;
      color: #e94560;
    }
    header span {
      color: #888;
      font-size: 0.9rem;
    }
    main {
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem;
    }
    .chat-entry {
      background: #16213e;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
      border-left: 3px solid #e94560;
    }
    .chat-meta {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.5rem;
      font-size: 0.85rem;
      color: #888;
    }
    .chat-user {
      color: #e94560;
      font-weight: bold;
    }
    .chat-message {
      background: #0f3460;
      padding: 0.75rem;
      border-radius: 4px;
      margin-bottom: 0.5rem;
      white-space: pre-wrap;
    }
    .chat-response {
      background: #1a1a2e;
      padding: 0.75rem;
      border-radius: 4px;
      border: 1px solid #0f3460;
      white-space: pre-wrap;
      max-height: 400px;
      overflow-y: auto;
    }
    .chat-response code {
      background: #0f3460;
      padding: 0.2rem 0.4rem;
      border-radius: 3px;
    }
    .empty {
      text-align: center;
      color: #666;
      padding: 3rem;
    }
    .refresh-btn {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: #e94560;
      color: white;
      border: none;
      padding: 1rem 1.5rem;
      border-radius: 50px;
      cursor: pointer;
      font-size: 1rem;
    }
    .refresh-btn:hover {
      background: #ff6b6b;
    }
  </style>
</head>
<body>
  <header>
    <h1>VEGA</h1>
    <span>Vector Encoded General Agent - Chat History</span>
  </header>
  <main id="chat-container">
    <div class="empty">Loading...</div>
  </main>
  <button class="refresh-btn" onclick="loadHistory()">Refresh</button>

  <script>
    async function loadHistory() {
      const container = document.getElementById('chat-container');
      try {
        const res = await fetch('/api/history');
        const history = await res.json();

        if (history.length === 0) {
          container.innerHTML = '<div class="empty">No chat history yet.</div>';
          return;
        }

        container.innerHTML = history.reverse().map(entry => \`
          <div class="chat-entry">
            <div class="chat-meta">
              <span class="chat-user">\${entry.user}</span>
              <span>\${new Date(entry.timestamp).toLocaleString(getDateLocale())}</span>
            </div>
            <div class="chat-message">\${escapeHtml(entry.message)}</div>
            <div class="chat-response">\${escapeHtml(entry.response)}</div>
          </div>
        \`).join('');
      } catch (err) {
        container.innerHTML = '<div class="empty">Failed to load history.</div>';
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    loadHistory();
    // Auto refresh every 30 seconds
    setInterval(loadHistory, 30000);
  </script>
</body>
</html>`;

/**
 * Start the web server
 */
export async function startWebServer(port: number = 3847): Promise<void> {
  // Skip if already running
  if (server) {
    console.log('Web interface already running, skipping...');
    return;
  }

  return new Promise((resolve, reject) => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '/';

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');

      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_TEMPLATE);
      } else if (url === '/api/history') {
        const history = await getChatHistory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} is already in use, skipping web server...`);
        server = null;
        resolve(); // Ignore error and continue
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`Web interface running at http://localhost:${port}`);
      resolve();
    });
  });
}

/**
 * Stop the web server
 */
export async function stopWebServer(): Promise<void> {
  if (server) {
    server.close();
    server = null;
  }
}
