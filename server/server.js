const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Vercel deployment
const allowedOrigins = [
  'https://funapp-nu.vercel.app',
  'https://funappbackend.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

console.log('Allowed origins:', allowedOrigins);

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());

// Configure Socket.IO for Vercel
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket'], // Try polling first
  allowEIO3: true
});

// Store connected users
const users = new Map();
const waitingUsers = [];

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
      websocket: '/socket.io/'
    },
    allowedOrigins: allowedOrigins
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id, 'Transport:', socket.conn.transport.name);
  
  // Add user to connected users
  users.set(socket.id, { socket, partner: null });
  
  // Send user their ID
  socket.emit('user-id', socket.id);
  
  // Try to pair users
  pairUsers();
  
  // Handle WebRTC signaling
  socket.on('offer', (data) => {
    const user = users.get(socket.id);
    if (user && user.partner) {
      console.log(`Offer from ${socket.id} to ${user.partner}`);
      io.to(user.partner).emit('offer', {
        offer: data.offer,
        from: socket.id
      });
    }
  });
  
  socket.on('answer', (data) => {
    const user = users.get(socket.id);
    if (user && user.partner) {
      console.log(`Answer from ${socket.id} to ${user.partner}`);
      io.to(user.partner).emit('answer', {
        answer: data.answer,
        from: socket.id
      });
    }
  });
  
  socket.on('ice-candidate', (data) => {
    const user = users.get(socket.id);
    if (user && user.partner) {
      io.to(user.partner).emit('ice-candidate', {
        candidate: data.candidate,
        from: socket.id
      });
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log('User disconnected:', socket.id, 'Reason:', reason);
    
    const user = users.get(socket.id);
    if (user && user.partner) {
      // Notify partner about disconnect
      io.to(user.partner).emit('partner-disconnected');
      
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
    users.delete(socket.id);
    const waitingIndex = waitingUsers.indexOf(socket.id);
    if (waitingIndex > -1) {
      waitingUsers.splice(waitingIndex, 1);
    }
    
    // Try to pair remaining users
    pairUsers();
  });
  
  socket.on('next-user', () => {
    const user = users.get(socket.id);
    if (user && user.partner) {
      // Notify current partner
      io.to(user.partner).emit('partner-disconnected');
      
      // Remove partnership
      const partner = users.get(user.partner);
      if (partner) {
        partner.partner = null;
        waitingUsers.push(user.partner);
      }
      
      user.partner = null;
      waitingUsers.push(socket.id);
      pairUsers();
    }
  });

  // Handle transport upgrade
  socket.conn.on("upgrade", (transport) => {
    console.log(`User ${socket.id} upgraded transport to:`, transport.name);
  });
});

function pairUsers() {
  while (waitingUsers.length >= 2) {
    const user1 = waitingUsers.shift();
    const user2 = waitingUsers.shift();
    
    const user1Data = users.get(user1);
    const user2Data = users.get(user2);
    
    if (user1Data && user2Data) {
      user1Data.partner = user2;
      user2Data.partner = user1;
      
      io.to(user1).emit('user-connected', { partnerId: user2 });
      io.to(user2).emit('user-connected', { partnerId: user1 });
      
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

const PORT = process.env.PORT || 5000;

// Export for Vercel
module.exports = app;

// Only listen if not in Vercel environment
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Allowed origins:', allowedOrigins);
  });
}