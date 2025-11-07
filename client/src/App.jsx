import React, { useState, useEffect, useRef } from 'react';
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
  const [userId, setUserId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [status, setStatus] = useState('Initializing...');
  const [isConnected, setIsConnected] = useState(false);
  
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const websocketRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    connectWebSocket();
    
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    const serverUrl = 'wss://funappbackend.vercel.app/ws';
    
    console.log('Connecting to WebSocket:', serverUrl);
    setStatus('Connecting to server...');

    try {
      const ws = new WebSocket(serverUrl);
      websocketRef.current = ws;

      ws.onopen = () => {
        console.log('✅ WebSocket connected successfully');
        setStatus('Connected! Waiting for a partner...');
        setIsConnected(true);
        
        // Clear any reconnect timeout
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        setStatus('Disconnected from server. Reconnecting...');
        setIsConnected(false);
        
        // Attempt to reconnect after 3 seconds
        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('Attempting to reconnect...');
            reconnectTimeoutRef.current = null;
            connectWebSocket();
          }, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setStatus('Connection error. Retrying...');
        setIsConnected(false);
      };

    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setStatus('Failed to connect. Retrying...');
      
      // Retry after 3 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connectWebSocket();
      }, 3000);
    }
  };

  const handleWebSocketMessage = (data) => {
    switch (data.type) {
      case 'user-id':
        setUserId(data.data);
        console.log('User ID received:', data.data);
        break;
        
      case 'user-connected':
        console.log('Partner connected:', data.data.partnerId);
        setPartnerId(data.data.partnerId);
        setStatus('Partner connected! Setting up video call...');
        createPeerConnection().then(() => createOffer());
        break;
        
      case 'offer':
        console.log('Received offer from:', data.data.from);
        setPartnerId(data.data.from);
        setStatus('Incoming call! Setting up video...');
        createPeerConnection().then(() => handleOffer(data.data.offer));
        break;
        
      case 'answer':
        console.log('Received answer from partner');
        handleAnswer(data.data.answer);
        break;
        
      case 'ice-candidate':
        console.log('Received ICE candidate');
        handleNewICECandidate(data.data.candidate);
        break;
        
      case 'partner-disconnected':
        console.log('Partner disconnected');
        setStatus('Partner disconnected. Waiting for new partner...');
        setPartnerId('');
        if (peerConnectionRef.current) {
          peerConnectionRef.current.close();
          peerConnectionRef.current = null;
        }
        break;
        
      default:
        console.log('Unknown message type:', data.type);
    }
  };

  const sendWebSocketMessage = (message) => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify(message));
    }
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
      if (!mediaSuccess) return false;
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
        if (event.candidate) {
          sendWebSocketMessage({
            type: 'ice-candidate',
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
      sendWebSocketMessage({
        type: 'offer',
        offer: offer
      });
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
      sendWebSocketMessage({
        type: 'answer',
        answer: answer
      });
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
    sendWebSocketMessage({ type: 'next-user' });
    setStatus('Looking for next user...');
    setPartnerId('');
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
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
    if (websocketRef.current) {
      websocketRef.current.close();
    }
    connectWebSocket();
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