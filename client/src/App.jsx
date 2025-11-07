import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
};

function App() {
  const [socket, setSocket] = useState(null);
  const [userId, setUserId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [status, setStatus] = useState('Initializing...');
  const [isConnected, setIsConnected] = useState(false);
  
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    initializeSocket();
  }, []);

  const initializeSocket = () => {
    const serverUrl = 'https://funappbackend.vercel.app';
    
    console.log('Connecting to server:', serverUrl);
    setStatus('Connecting to server...');

    // Create socket with explicit configuration
    const newSocket = io(serverUrl, {
      transports: ['polling', 'websocket'],
      upgrade: true,
      forceNew: true,
      timeout: 10000,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('✅ Connected to server successfully');
      setStatus('Connected! Waiting for a partner...');
      setIsConnected(true);
    });

    newSocket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error);
      setStatus(`Connection failed: ${error.message}. Retrying...`);
      setIsConnected(false);
      
      // Try to reconnect after 3 seconds
      setTimeout(() => {
        if (socketRef.current && !socketRef.current.connected) {
          console.log('Attempting to reconnect...');
          socketRef.current.connect();
        }
      }, 3000);
    });

    newSocket.on('user-id', (id) => {
      setUserId(id);
      console.log('User ID received:', id);
    });

    newSocket.on('user-connected', async (data) => {
      console.log('Partner connected:', data.partnerId);
      setPartnerId(data.partnerId);
      setStatus('Partner connected! Setting up video call...');
      await createPeerConnection();
      await createOffer();
    });

    newSocket.on('offer', async (data) => {
      console.log('Received offer from:', data.from);
      setPartnerId(data.from);
      setStatus('Incoming call! Setting up video...');
      await createPeerConnection();
      await handleOffer(data.offer);
    });

    newSocket.on('answer', async (data) => {
      console.log('Received answer from partner');
      await handleAnswer(data.answer);
    });

    newSocket.on('ice-candidate', async (data) => {
      console.log('Received ICE candidate');
      await handleNewICECandidate(data.candidate);
    });

    newSocket.on('partner-disconnected', () => {
      console.log('Partner disconnected');
      setStatus('Partner disconnected. Waiting for new partner...');
      setPartnerId('');
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    });

    newSocket.on('disconnect', (reason) => {
      console.log('Disconnected from server:', reason);
      setStatus('Disconnected from server. Reconnecting...');
      setIsConnected(false);
    });

    newSocket.on('reconnect', (attemptNumber) => {
      console.log('Reconnected to server after', attemptNumber, 'attempts');
      setStatus('Reconnected! Waiting for partner...');
      setIsConnected(true);
    });
  };

  const initializeMedia = async () => {
    try {
      setStatus('Requesting camera and microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setStatus('Camera and microphone ready! Waiting for partner...');
      return true;
    } catch (error) {
      console.error('Error accessing media devices:', error);
      setStatus('Error: Cannot access camera/microphone. Please check permissions.');
      return false;
    }
  };

  const createPeerConnection = async () => {
    if (!localStreamRef.current) {
      const mediaSuccess = await initializeMedia();
      if (!mediaSuccess) return;
    }

    try {
      const peerConnection = new RTCPeerConnection(ICE_SERVERS);
      
      // Add local stream to peer connection
      localStreamRef.current.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStreamRef.current);
      });

      // Handle incoming remote stream
      peerConnection.ontrack = (event) => {
        console.log('Received remote stream');
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
        setStatus('Video call connected!');
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = (event) => {
        if (event.candidate && socketRef.current) {
          socketRef.current.emit('ice-candidate', {
            candidate: event.candidate
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        console.log('Peer connection state:', peerConnection.connectionState);
        switch (peerConnection.connectionState) {
          case 'connected':
            setStatus('Video call connected!');
            break;
          case 'disconnected':
          case 'failed':
            setStatus('Connection issues. Trying to reconnect...');
            break;
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', peerConnection.iceConnectionState);
      };

      peerConnectionRef.current = peerConnection;
      return true;
    } catch (error) {
      console.error('Error creating peer connection:', error);
      setStatus('Error setting up connection');
      return false;
    }
  };

  const createOffer = async () => {
    if (!peerConnectionRef.current) return;

    try {
      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);
      socketRef.current.emit('offer', { offer });
    } catch (error) {
      console.error('Error creating offer:', error);
    }
  };

  const handleOffer = async (offer) => {
    if (!peerConnectionRef.current) return;

    try {
      await peerConnectionRef.current.setRemoteDescription(offer);
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socketRef.current.emit('answer', { answer });
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  };

  const handleAnswer = async (answer) => {
    if (!peerConnectionRef.current) return;

    try {
      await peerConnectionRef.current.setRemoteDescription(answer);
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  };

  const handleNewICECandidate = async (candidate) => {
    if (!peerConnectionRef.current || !candidate) return;

    try {
      await peerConnectionRef.current.addIceCandidate(candidate);
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  };

  const handleNextUser = () => {
    if (socketRef.current) {
      socketRef.current.emit('next-user');
      setStatus('Looking for next user...');
      setPartnerId('');
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    }
  };

  const toggleMedia = (type, enable) => {
    if (!localStreamRef.current) return;

    const tracks = localStreamRef.current.getTracks();
    tracks.forEach(track => {
      if (track.kind === type) {
        track.enabled = enable;
      }
    });
  };

  const reconnect = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current.connect();
    }
    initializeSocket();
  };

  return (
    <div className="app">
      <div className="header">
        <h1>Random Video Chat</h1>
        <div className="status">
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '● Connected' : '● Disconnected'}
          </div>
          <div className="user-id">Your ID: {userId || 'Connecting...'}</div>
          <button onClick={reconnect} className="reconnect-btn">
            🔄 Reconnect
          </button>
        </div>
      </div>

      <div className="main-content">
        <div className="video-container">
          <div className="video-wrapper">
            <h3>Your Video</h3>
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className="video-element"
            />
            <div className="video-controls">
              <button 
                onClick={() => toggleMedia('video', false)}
                className="control-btn"
              >
                📷 Mute Video
              </button>
              <button 
                onClick={() => toggleMedia('video', true)}
                className="control-btn"
              >
                📷 Unmute Video
              </button>
              <button 
                onClick={() => toggleMedia('audio', false)}
                className="control-btn"
              >
                🎤 Mute Audio
              </button>
              <button 
                onClick={() => toggleMedia('audio', true)}
                className="control-btn"
              >
                🎤 Unmute Audio
              </button>
            </div>
          </div>

          <div className="video-wrapper">
            <h3>Partner's Video {partnerId && `- ${partnerId.substring(0, 8)}`}</h3>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="video-element"
            />
            {partnerId && (
              <div className="partner-controls">
                <button onClick={handleNextUser} className="next-btn">
                  🔄 Next User
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="status-panel">
          <div className="status-message">{status}</div>
          {!partnerId && isConnected && (
            <button 
              onClick={initializeMedia} 
              className="media-btn"
            >
              🎥 Start Camera & Microphone
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;