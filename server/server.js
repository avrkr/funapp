const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS
const allowedOrigins = [
  'https://funapp-nu.vercel.app',
  'https://funappbackend.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());

// Store connected users
const users = new Map();
const waitingUsers = [];

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: '/ws'
});

// API health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'WebRTC Server is running',
    users: users.size,
    waiting: waitingUsers.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'WebRTC Chat Server is running',
    endpoints: {
      health: '/api/health',
      websocket: '/ws'
    },
    allowedOrigins: allowedOrigins
  });
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const userId = generateUserId();
  console.log('User connected:', userId);
  
  // Add user to connected users
  users.set(userId, { ws, partner: null });
  
  // Send user their ID
  sendToUser(userId, { type: 'user-id', data: userId });
  
  // Try to pair users
  pairUsers();
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(userId, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('User disconnected:', userId);
    
    const user = users.get(userId);
    if (user && user.partner) {
      // Notify partner about disconnect
      sendToUser(user.partner, { type: 'partner-disconnected' });
      
      // Remove partner reference
      const partner = users.get(user.partner);
      if (partner) {
        partner.partner = null;
        // Add partner back to waiting list if they're still connected
        if (users.has(user.partner)) {
          waitingUsers.push(user.partner);
        }
      }
    }
    
    // Remove user from all collections
    users.delete(userId);
    const waitingIndex = waitingUsers.indexOf(userId);
    if (waitingIndex > -1) {
      waitingUsers.splice(waitingIndex, 1);
    }
    
    // Try to pair remaining users
    pairUsers();
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error for user', userId, ':', error);
  });
});

function handleMessage(userId, data) {
  const user = users.get(userId);
  
  switch (data.type) {
    case 'offer':
      if (user && user.partner) {
        sendToUser(user.partner, {
          type: 'offer',
          data: {
            offer: data.offer,
            from: userId
          }
        });
      }
      break;
      
    case 'answer':
      if (user && user.partner) {
        sendToUser(user.partner, {
          type: 'answer',
          data: {
            answer: data.answer,
            from: userId
          }
        });
      }
      break;
      
    case 'ice-candidate':
      if (user && user.partner) {
        sendToUser(user.partner, {
          type: 'ice-candidate',
          data: {
            candidate: data.candidate,
            from: userId
          }
        });
      }
      break;
      
    case 'next-user':
      if (user && user.partner) {
        // Notify current partner
        sendToUser(user.partner, { type: 'partner-disconnected' });
        
        // Remove partnership
        const partner = users.get(user.partner);
        if (partner) {
          partner.partner = null;
          waitingUsers.push(user.partner);
        }
        
        user.partner = null;
        waitingUsers.push(userId);
        pairUsers();
      }
      break;
      
    default:
      console.log('Unknown message type:', data.type);
  }
}

function sendToUser(userId, message) {
  const user = users.get(userId);
  if (user && user.ws.readyState === WebSocket.OPEN) {
    user.ws.send(JSON.stringify(message));
  }
}

function pairUsers() {
  while (waitingUsers.length >= 2) {
    const user1 = waitingUsers.shift();
    const user2 = waitingUsers.shift();
    
    const user1Data = users.get(user1);
    const user2Data = users.get(user2);
    
    if (user1Data && user2Data) {
      user1Data.partner = user2;
      user2Data.partner = user1;
      
      sendToUser(user1, { 
        type: 'user-connected', 
        data: { partnerId: user2 } 
      });
      
      sendToUser(user2, { 
        type: 'user-connected', 
        data: { partnerId: user1 } 
      });
      
      console.log(`Paired users: ${user1} with ${user2}`);
    }
  }
  
  // Add single user to waiting if not already there
  users.forEach((userData, userId) => {
    if (!userData.partner && !waitingUsers.includes(userId)) {
      waitingUsers.push(userId);
    }
  });
}

function generateUserId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

const PORT = process.env.PORT || 5000;

// Export for Vercel
module.exports = app;

// Only listen if not in Vercel environment
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('WebSocket server running on path /ws');
    console.log('Allowed origins:', allowedOrigins);
  });
}