const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

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

// Store connected users and their SSE responses
const users = new Map();
const waitingUsers = [];
const userConnections = new Map();

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
      events: '/api/events',
      signaling: '/api/signal'
    },
    allowedOrigins: allowedOrigins
  });
});

// SSE endpoint for receiving events
app.get('/api/events', (req, res) => {
  const userId = req.query.userId;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }

  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true'
  });

  // Send initial heartbeat to establish connection
  res.write('data: ' + JSON.stringify({ type: 'connected', data: { userId } }) + '\n\n');

  // Store the connection
  userConnections.set(userId, res);

  // Add user to system if not already there
  if (!users.has(userId)) {
    users.set(userId, { partner: null });
    waitingUsers.push(userId);
    pairUsers();
  }

  // Send periodic heartbeats to keep connection alive
  const heartbeat = setInterval(() => {
    if (userConnections.has(userId)) {
      try {
        res.write('data: ' + JSON.stringify({ type: 'heartbeat' }) + '\n\n');
      } catch (error) {
        clearInterval(heartbeat);
      }
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    console.log('User disconnected:', userId);
    clearInterval(heartbeat);
    userConnections.delete(userId);
    
    const user = users.get(userId);
    if (user && user.partner) {
      // Notify partner about disconnect
      sendToUser(user.partner, { type: 'partner-disconnected' });
      
      // Remove partner reference
      const partner = users.get(user.partner);
      if (partner) {
        partner.partner = null;
        if (users.has(user.partner)) {
          waitingUsers.push(user.partner);
        }
      }
    }
    
    users.delete(userId);
    const waitingIndex = waitingUsers.indexOf(userId);
    if (waitingIndex > -1) {
      waitingUsers.splice(waitingIndex, 1);
    }
    
    pairUsers();
  });
});

// Signaling endpoint for WebRTC offers/answers/ice-candidates
app.post('/api/signal', (req, res) => {
  try {
    const { userId, type, data } = req.body;
    
    console.log('Received signal:', { userId, type, data: data ? 'data present' : 'no data' });
    
    if (!userId || !type) {
      return res.status(400).json({ error: 'User ID and type required' });
    }

    const user = users.get(userId);
    
    switch (type) {
      case 'offer':
        if (user && user.partner) {
          sendToUser(user.partner, {
            type: 'offer',
            data: {
              offer: data?.offer,
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
              answer: data?.answer,
              from: userId
            }
          });
        }
        break;
        
      case 'ice-candidate':
        if (user && user.partner && data?.candidate) {
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
        
      case 'join':
        if (!users.has(userId)) {
          users.set(userId, { partner: null });
          waitingUsers.push(userId);
          pairUsers();
        }
        break;
        
      default:
        console.log('Unknown signal type:', type);
    }

    res.json({ status: 'ok', message: 'Signal processed' });
  } catch (error) {
    console.error('Error processing signal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function sendToUser(userId, message) {
  const connection = userConnections.get(userId);
  if (connection && !connection.finished) {
    try {
      const messageStr = 'data: ' + JSON.stringify(message) + '\n\n';
      connection.write(messageStr);
      console.log('Sent to user', userId, ':', message.type);
    } catch (error) {
      console.error('Error sending to user:', userId, error);
      userConnections.delete(userId);
    }
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
}

// Generate user ID endpoint
app.get('/api/user-id', (req, res) => {
  const userId = uuidv4();
  res.json({ userId });
});

const PORT = process.env.PORT || 5000;

// Export for Vercel
module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Allowed origins:', allowedOrigins);
  });
}