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
    users: users.size,
    waiting: waitingUsers.length
  });
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'WebRTC Chat Server',
    endpoints: {
      health: '/api/health',
      events: '/api/events',
      signal: '/api/signal'
    }
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
    'Connection': 'keep-alive'
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`);

  userConnections.set(userId, res);

  if (!users.has(userId)) {
    users.set(userId, { partner: null, ready: false });
    waitingUsers.push(userId);
    console.log(`User ${userId.substring(0, 8)} joined, waiting: ${waitingUsers.length}`);
    pairUsers();
  }

  const heartbeat = setInterval(() => {
    if (userConnections.has(userId)) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      } catch (e) {
        clearInterval(heartbeat);
      }
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    console.log(`User ${userId.substring(0, 8)} disconnected`);
    clearInterval(heartbeat);
    userConnections.delete(userId);
    
    const user = users.get(userId);
    if (user && user.partner) {
      sendToUser(user.partner, { type: 'partner-disconnected' });
      
      const partner = users.get(user.partner);
      if (partner) {
        partner.partner = null;
        partner.ready = false;
        if (!waitingUsers.includes(user.partner)) {
          waitingUsers.push(user.partner);
          pairUsers();
        }
      }
    }
    
    users.delete(userId);
    const idx = waitingUsers.indexOf(userId);
    if (idx > -1) {
      waitingUsers.splice(idx, 1);
    }
  });
});

app.post('/api/signal', (req, res) => {
  const { userId, type, data } = req.body;
  
  if (!userId || !type) {
    console.error('Missing userId or type:', { userId, type });
    return res.status(400).json({ error: 'userId and type required' });
  }

  console.log(`Signal: ${type} from ${userId.substring(0, 8)}`);

  const user = users.get(userId);
  
  if (!user) {
    console.error('User not found:', userId.substring(0, 8));
    return res.status(404).json({ error: 'User not found' });
  }

  switch (type) {
    case 'ready':
      user.ready = true;
      console.log(`User ${userId.substring(0, 8)} ready`);
      
      if (user.partner) {
        const partner = users.get(user.partner);
        if (partner && partner.ready) {
          console.log(`Both users ready, starting call`);
          sendToUser(userId, { type: 'start-call', initiator: true });
          sendToUser(user.partner, { type: 'start-call', initiator: false });
        }
      }
      break;

    case 'offer':
      if (user.partner) {
        console.log(`Relaying offer: ${userId.substring(0, 8)} → ${user.partner.substring(0, 8)}`);
        sendToUser(user.partner, { type: 'offer', offer: data.offer, from: userId });
      }
      break;

    case 'answer':
      if (user.partner) {
        console.log(`Relaying answer: ${userId.substring(0, 8)} → ${user.partner.substring(0, 8)}`);
        sendToUser(user.partner, { type: 'answer', answer: data.answer, from: userId });
      }
      break;

    case 'ice-candidate':
      if (user.partner && data.candidate) {
        sendToUser(user.partner, { type: 'ice-candidate', candidate: data.candidate, from: userId });
      }
      break;

    case 'next':
      if (user.partner) {
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
  }

  res.json({ success: true });
});

function sendToUser(userId, message) {
  const conn = userConnections.get(userId);
  if (conn && !conn.finished) {
    try {
      conn.write(`data: ${JSON.stringify(message)}\n\n`);
    } catch (e) {
      console.error('Send error:', e);
      userConnections.delete(userId);
    }
  }
}

function pairUsers() {
  while (waitingUsers.length >= 2) {
    const id1 = waitingUsers.shift();
    const id2 = waitingUsers.shift();
    
    const user1 = users.get(id1);
    const user2 = users.get(id2);
    
    if (user1 && user2) {
      user1.partner = id2;
      user2.partner = id1;
      user1.ready = false;
      user2.ready = false;
      
      sendToUser(id1, { type: 'partner-found', partnerId: id2 });
      sendToUser(id2, { type: 'partner-found', partnerId: id1 });
      
      console.log(`Paired: ${id1.substring(0, 8)} ↔ ${id2.substring(0, 8)}`);
    }
  }
}

app.get('/api/user-id', (req, res) => {
  res.json({ userId: uuidv4() });
});

const PORT = process.env.PORT || 5000;

module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server on port ${PORT}`);
  });
}