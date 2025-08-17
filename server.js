const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { scanSymbols } = require('./scanner');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

// Store latest scan results and history
let latestResults = {
  hotNow: null,
  rising: null,
  coolingOff: null,
  timestamp: null,
  scanning: false
};

// Store last 100 scan results
let scanHistory = [];

// Serve static files from public directory
app.use(express.static('public'));

// API endpoint to get latest results
app.get('/api/results', (req, res) => {
  res.json(latestResults);
});

// API endpoint to get scan history
app.get('/api/history', (req, res) => {
  res.json(scanHistory);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// WebSocket connection handling
io.on('connection', (socket) => {
  // Send current results and history to new client
  socket.emit('currentResults', latestResults);
  socket.emit('scanHistory', scanHistory);

  // Handle client disconnect to prevent memory leaks
  socket.on('disconnect', () => {
    // Socket.io automatically cleans up, but we can add custom cleanup here if needed
  });
});

// Function to run the scan
async function runScan() {
  if (latestResults.scanning) {
    return;
  }

  latestResults.scanning = true;

  try {
    const results = await scanSymbols();
    const scanResult = {
      ...results,
      timestamp: new Date().toISOString(),
      scanning: false
    };

    latestResults = scanResult;

    // Add to history and keep only last 100
    scanHistory.unshift(scanResult);
    if (scanHistory.length > 100) {
      scanHistory = scanHistory.slice(0, 100);
    }

    // Emit to all connected clients
    io.emit('newScanResult', scanResult);
    io.emit('scanHistory', scanHistory);

  } catch (error) {
    latestResults.scanning = false;
  }
}

// Real-time clock checker - runs every second
function startClockChecker() {
  setInterval(() => {
    const now = new Date();
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    const hours = now.getHours();

    // Daily restart at 00:00:03
    if (hours === 0 && minutes === 0 && seconds === 3) {
      console.log('Daily restart at 00:00:03');
      process.exit(0); // Exit gracefully, assuming process manager will restart
    }

    // Run scan at exactly 3 seconds past each minute
    if (seconds === 3) {
      runScan();
    }
  }, 1000); // Check every second
}

// Start the clock checker
startClockChecker();

// Run initial scan on startup (after 2 seconds)
setTimeout(runScan, 2000);

server.listen(PORT, () => {
  console.log(`Bybit Volatility Scanner server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to view results`);
});
