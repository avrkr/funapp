const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
require('dotenv').config();

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

app.use(express.json({ limit: '10mb' }));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/webrtc-chat';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// MongoDB Schemas
const userSessionSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  partnerId: { type: String, default: null },
  status: { type: String, default: 'waiting' }, // waiting, connected, disconnected
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const UserSession = mongoose.model('UserSession', userSessionSchema);

// In-memory stores for active connections (these are temporary)
const userConnections = new Map(); // userId -> SSE response
const waitingUsers = []; // Array of userIds waiting for partners

// API health check
app.get('/api/health', async (req, res) => {
  try {
    const activeUsers = await UserSession.countDocuments({ status: 'connected' });
    const waitingCount = waitingUsers.length;
    
    res.json({ 
      status: 'OK', 
      message: 'WebRTC Server is running',
      database: 'Connected',
      activeUsers: activeUsers,
      waitingUsers: waitingCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
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
app.get('/api/events', async (req, res) => {
  const userId = req.query.userId;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }

  try {
    // Check if user exists in database, create if not
    let userSession = await UserSession.findOne({ userId });
    if (!userSession) {
      userSession = new UserSession({ 
        userId, 
        status: 'waiting',
        lastActive: new Date()
      });
      await userSession.save();
    } else {
      // Update user status to connected
      userSession.status = 'waiting';
      userSession.lastActive = new Date();
      await userSession.save();
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
    res.write(`data: ${JSON.stringify({ type: 'connected', data: { userId } })}\n\n`);

    // Store the connection in memory
    userConnections.set(userId, res);

    // Add user to waiting list if not already there
    if (!waitingUsers.includes(userId)) {
      waitingUsers.push(userId);
    }

    // Try to pair users
    await pairUsers();

    // Send periodic heartbeats to keep connection alive
    const heartbeat = setInterval(async () => {
      if (userConnections.has(userId)) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
          
          // Update last active time
          await UserSession.updateOne(
            { userId }, 
            { lastActive: new Date() }
          );
        } catch (error) {
          clearInterval(heartbeat);
        }
      } else {
        clearInterval(heartbeat);
      }
    }, 30000);

    // Handle client disconnect
    req.on('close', async () => {
      console.log('User disconnected:', userId);
      clearInterval(heartbeat);
      
      // Remove from in-memory stores
      userConnections.delete(userId);
      const waitingIndex = waitingUsers.indexOf(userId);
      if (waitingIndex > -1) {
        waitingUsers.splice(waitingIndex, 1);
      }

      // Update database
      const userSession = await UserSession.findOne({ userId });
      if (userSession && userSession.partnerId) {
        // Notify partner about disconnect
        sendToUser(userSession.partnerId, { type: 'partner-disconnected' });
        
        // Update partner's session
        await UserSession.updateOne(
          { userId: userSession.partnerId },
          { partnerId: null, status: 'waiting' }
        );
        
        // Add partner back to waiting list
        if (!waitingUsers.includes(userSession.partnerId)) {
          waitingUsers.push(userSession.partnerId);
        }
      }

      // Update user session
      await UserSession.updateOne(
        { userId },
        { 
          partnerId: null, 
          status: 'disconnected',
          lastActive: new Date()
        }
      );

      // Try to pair remaining users
      await pairUsers();
    });

  } catch (error) {
    console.error('Error in events endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Signaling endpoint for WebRTC offers/answers/ice-candidates
app.post('/api/signal', async (req, res) => {
  try {
    const { userId, type, data } = req.body;
    
    console.log('Received signal:', type, 'from user:', userId);
    
    if (!userId || !type) {
      return res.status(400).json({ error: 'User ID and type required' });
    }

    // Check if user exists in database
    const userSession = await UserSession.findOne({ userId });
    if (!userSession) {
      return res.status(404).json({ error: 'User not found' });
    }

    switch (type) {
      case 'offer':
        if (userSession.partnerId) {
          console.log('Forwarding offer to partner:', userSession.partnerId);
          sendToUser(userSession.partnerId, {
            type: 'offer',
            data: {
              offer: data?.offer,
              from: userId
            }
          });
        } else {
          console.log('No partner for user:', userId);
        }
        break;
        
      case 'answer':
        if (userSession.partnerId) {
          console.log('Forwarding answer to partner:', userSession.partnerId);
          sendToUser(userSession.partnerId, {
            type: 'answer',
            data: {
              answer: data?.answer,
              from: userId
            }
          });
        }
        break;
        
      case 'ice-candidate':
        if (userSession.partnerId && data?.candidate) {
          console.log('Forwarding ICE candidate to partner:', userSession.partnerId);
          sendToUser(userSession.partnerId, {
            type: 'ice-candidate',
            data: {
              candidate: data.candidate,
              from: userId
            }
          });
        }
        break;
        
      case 'next-user':
        if (userSession.partnerId) {
          console.log('User requesting next partner');
          
          // Notify current partner
          sendToUser(userSession.partnerId, { type: 'partner-disconnected' });
          
          // Update partner's session
          await UserSession.updateOne(
            { userId: userSession.partnerId },
            { partnerId: null, status: 'waiting' }
          );
          
          // Add partner back to waiting list
          if (!waitingUsers.includes(userSession.partnerId)) {
            waitingUsers.push(userSession.partnerId);
          }
          
          // Update current user's session
          await UserSession.updateOne(
            { userId },
            { partnerId: null, status: 'waiting' }
          );
          
          // Add current user back to waiting list
          if (!waitingUsers.includes(userId)) {
            waitingUsers.push(userId);
          }
          
          await pairUsers();
        }
        break;
        
      case 'join':
        console.log('User joined:', userId);
        // Update user status
        await UserSession.updateOne(
          { userId },
          { status: 'waiting', lastActive: new Date() }
        );
        
        // Add to waiting list if not already there
        if (!waitingUsers.includes(userId)) {
          waitingUsers.push(userId);
        }
        
        await pairUsers();
        break;
        
      default:
        console.log('Unknown signal type:', type);
    }

    // Update last active time
    await UserSession.updateOne(
      { userId },
      { lastActive: new Date() }
    );

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
      const messageStr = `data: ${JSON.stringify(message)}\n\n`;
      connection.write(messageStr);
      console.log('Sent to user', userId, ':', message.type);
    } catch (error) {
      console.error('Error sending to user:', userId, error);
      userConnections.delete(userId);
    }
  } else {
    console.log('No active connection for user:', userId);
  }
}

async function pairUsers() {
  console.log('Pairing users. Waiting:', waitingUsers.length);
  
  while (waitingUsers.length >= 2) {
    const user1 = waitingUsers.shift();
    const user2 = waitingUsers.shift();
    
    try {
      // Update both users in database
      await UserSession.updateOne(
        { userId: user1 },
        { partnerId: user2, status: 'connected' }
      );
      
      await UserSession.updateOne(
        { userId: user2 },
        { partnerId: user1, status: 'connected' }
      );
      
      console.log(`Paired users: ${user1} with ${user2}`);
      
      // Notify both users
      sendToUser(user1, { 
        type: 'user-connected', 
        data: { partnerId: user2 } 
      });
      
      sendToUser(user2, { 
        type: 'user-connected', 
        data: { partnerId: user1 } 
      });
    } catch (error) {
      console.error('Error pairing users:', error);
      // Put users back in waiting list if pairing failed
      if (!waitingUsers.includes(user1)) waitingUsers.push(user1);
      if (!waitingUsers.includes(user2)) waitingUsers.push(user2);
    }
  }
}

// Generate user ID endpoint
app.get('/api/user-id', async (req, res) => {
  const userId = uuidv4();
  
  try {
    // Create new user session in database
    const userSession = new UserSession({ 
      userId, 
      status: 'waiting',
      lastActive: new Date()
    });
    await userSession.save();
    
    res.json({ userId });
  } catch (error) {
    console.error('Error creating user session:', error);
    res.status(500).json({ error: 'Failed to create user session' });
  }
});

// Cleanup inactive users (run every 5 minutes)
setInterval(async () => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const result = await UserSession.deleteMany({ 
      lastActive: { $lt: fiveMinutesAgo } 
    });
    
    if (result.deletedCount > 0) {
      console.log(`Cleaned up ${result.deletedCount} inactive users`);
    }
  } catch (error) {
    console.error('Error cleaning up inactive users:', error);
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 5000;

// Export for Vercel
module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Allowed origins:', allowedOrigins);
  });
}