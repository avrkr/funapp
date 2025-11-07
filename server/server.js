const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Vercel
app.use(cors({
  origin: function (origin, callback) {
    // Allow all origins in production for demo purposes
    // For production, you might want to restrict this
    callback(null, true);
  },
  credentials: true
}));

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Store connected users
const users = new Map();
const waitingUsers = [];

// Health check endpoint
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
    }
  });
});

// Socket.IO connection handling (same as before)
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  users.set(socket.id, { socket, partner: null });
  socket.emit('user-id', socket.id);
  pairUsers();
  
  socket.on('offer', (data) => {
    const user = users.get(socket.id);
    if (user && user.partner) {
      io.to(user.partner).emit('offer', {
        offer: data.offer,
        from: socket.id
      });
    }
  });
  
  socket.on('answer', (data) => {
    const user = users.get(socket.id);
    if (user && user.partner) {
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
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const user = users.get(socket.id);
    
    if (user && user.partner) {
      io.to(user.partner).emit('partner-disconnected');
      const partner = users.get(user.partner);
      if (partner) {
        partner.partner = null;
        if (users.has(user.partner)) {
          waitingUsers.push(user.partner);
        }
      }
    }
    
    users.delete(socket.id);
    const waitingIndex = waitingUsers.indexOf(socket.id);
    if (waitingIndex > -1) {
      waitingUsers.splice(waitingIndex, 1);
    }
    
    pairUsers();
  });
  
  socket.on('next-user', () => {
    const user = users.get(socket.id);
    if (user && user.partner) {
      io.to(user.partner).emit('partner-disconnected');
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
    }
  }
  
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
  });
}