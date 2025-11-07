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
  const [status, setStatus] = useState('Connecting to server...');
  const [isConnected, setIsConnected] = useState(false);
  
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    // Initialize socket connection
    const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000';
    const newSocket = io(serverUrl, {
      transports: ['websocket', 'polling']
    });
    
    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Connected to server');
      setStatus('Waiting for a partner...');
      setIsConnected(true);
    });

    newSocket.on('user-id', (id) => {
      setUserId(id);
    });

    newSocket.on('user-connected', async (data) => {
      setPartnerId(data.partnerId);
      setStatus('Connected to partner!');
      await createPeerConnection();
      await createOffer();
    });

    newSocket.on('offer', async (data) => {
      setPartnerId(data.from);
      setStatus('Partner joined!');
      await createPeerConnection();
      await handleOffer(data.offer);
    });

    newSocket.on('answer', async (data) => {
      await handleAnswer(data.answer);
    });

    newSocket.on('ice-candidate', async (data) => {
      await handleNewICECandidate(data.candidate);
    });

    newSocket.on('partner-disconnected', () => {
      setStatus('Partner disconnected. Waiting for new partner...');
      setPartnerId('');
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    });

    newSocket.on('disconnect', () => {
      setStatus('Disconnected from server. Reconnecting...');
      setIsConnected(false);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  const initializeMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('Error accessing media devices:', error);
      setStatus('Error accessing camera/microphone');
    }
  };

  const createPeerConnection = async () => {
    if (!localStreamRef.current) {
      await initializeMedia();
    }

    try {
      const peerConnection = new RTCPeerConnection(ICE_SERVERS);
      
      // Add local stream to peer connection
      localStreamRef.current.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStreamRef.current);
      });

      // Handle incoming remote stream
      peerConnection.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
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
        console.log('Connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'connected') {
          setStatus('Connected!');
        }
      };

      peerConnectionRef.current = peerConnection;
    } catch (error) {
      console.error('Error creating peer connection:', error);
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

  const toggleMedia = async (type, enable) => {
    if (!localStreamRef.current) return;

    const tracks = localStreamRef.current.getTracks();
    tracks.forEach(track => {
      if (track.kind === type) {
        track.enabled = enable;
      }
    });
  };

  return (
    <div className="app">
      <div className="header">
        <h1>Random Video Chat</h1>
        <div className="status">
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '● Connected' : '● Disconnected'}
          </div>
          <div className="user-id">Your ID: {userId}</div>
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