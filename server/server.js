const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();

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

const users = new Map();
const waitingUsers = [];
const userConnections = new Map();

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

app.get('/api/events', (req, res) => {
  const userId = req.query.userId;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true'
  });

  res.write('data: ' + JSON.stringify({ type: 'connected', data: { userId } }) + '\n\n');

  userConnections.set(userId, res);

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

  req.on('close', () => {
    console.log('User disconnected:', userId);
    clearInterval(heartbeat);
    userConnections.delete(userId);
    
    const user = users.get(userId);
    if (user && user.partner) {
      sendToUser(user.partner, { type: 'partner-disconnected' });
      
      const partner = users.get(user.partner);
      if (partner) {
        partner.partner = null;
        if (users.has(user.partner)) {
          waitingUsers.push(user.partner);
          pairUsers();
        }
      }
    }
    
    users.delete(userId);
    const waitingIndex = waitingUsers.indexOf(userId);
    if (waitingIndex > -1) {
      waitingUsers.splice(waitingIndex, 1);
    }
  });
});

app.post('/api/signal', (req, res) => {
  try {
    const { userId, type, data } = req.body;
    
    console.log('Received signal:', { userId, type });
    
    if (!userId || !type) {
      return res.status(400).json({ error: 'User ID and type required' });
    }

    const user = users.get(userId);
    
    switch (type) {
      case 'join':
        if (!users.has(userId)) {
          users.set(userId, { partner: null, ready: false });
          waitingUsers.push(userId);
          console.log('User joined:', userId);
          pairUsers();
        }
        break;

      case 'ready':
        if (user) {
          user.ready = true;
          console.log('User ready:', userId);
          
          if (user.partner) {
            const partner = users.get(user.partner);
            if (partner && partner.ready) {
              sendToUser(userId, { 
                type: 'start-call', 
                data: { partnerId: user.partner, initiator: true } 
              });
              sendToUser(user.partner, { 
                type: 'start-call', 
                data: { partnerId: userId, initiator: false } 
              });
            }
          }
        }
        break;
        
      case 'offer':
        if (user && user.partner) {
          console.log('Relaying offer from', userId, 'to', user.partner);
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
          console.log('Relaying answer from', userId, 'to', user.partner);
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
          sendToUser(user.partner, { type: 'partner-disconnected' });
          
          const partner = users.get(user.partner);
          if (partner) {
            partner.partner = null;
            partner.ready = false;
            waitingUsers.push(user.partner);
          }
          
          user.partner = null;
          user.ready = false;
          waitingUsers.push(userId);
          pairUsers();
        }
        break;
        
      default:
        console.log('Unknown signal type:', type);
    }

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error processing signal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function sendToUser(userId, message) {
  const connection = userConnections.get(userId);
  if (connection && !connection.finished) {
    try {
      connection.write('data: ' + JSON.stringify(message) + '\n\n');
      console.log('Sent to', userId, ':', message.type);
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
      
      console.log(`Paired: ${user1} <-> ${user2}`);
    }
  }
}

app.get('/api/user-id', (req, res) => {
  const userId = uuidv4();
  res.json({ userId });
});

const PORT = process.env.PORT || 5000;

module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}