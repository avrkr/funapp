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

const SERVER_URL = 'https://funappbackend.vercel.app';

function App() {
  const [userId, setUserId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [status, setStatus] = useState('Initializing...');
  const [isConnected, setIsConnected] = useState(false);
  
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    initializeUser();
    
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, []);

  const initializeUser = async () => {
    try {
      setStatus('Getting user ID...');
      
      // Get a user ID from server
      const response = await fetch(`${SERVER_URL}/api/user-id`);
      const data = await response.json();
      
      const newUserId = data.userId;
      setUserId(newUserId);
      setStatus('User ID received. Connecting...');
      
      // Connect to events stream first
      connectEventSource(newUserId);
      
    } catch (error) {
      console.error('Error initializing user:', error);
      setStatus('Failed to initialize. Retrying...');
      
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        initializeUser();
      }, 3000);
    }
  };

  const connectEventSource = (userId) => {
    try {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      setStatus('Connecting to server...');
      
      const eventSource = new EventSource(`${SERVER_URL}/api/events?userId=${userId}`);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('✅ EventSource connected successfully');
        setStatus('Connected! Waiting for a partner...');
        setIsConnected(true);
        
        // Join the chat system after connection is established
        sendSignal('join', {}, userId);
        
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleServerEvent(data);
        } catch (error) {
          console.error('Error parsing server event:', error);
        }
      };

      eventSource.onerror = (error) => {
        console.error('EventSource error:', error);
        setStatus('Connection error. Reconnecting...');
        setIsConnected(false);
        
        eventSource.close();
        
        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            if (userId) {
              connectEventSource(userId);
            }
          }, 3000);
        }
      };

    } catch (error) {
      console.error('Error creating EventSource:', error);
      setStatus('Failed to connect. Retrying...');
      
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        if (userId) {
          connectEventSource(userId);
        }
      }, 3000);
    }
  };

  const handleServerEvent = (data) => {
    console.log('Received server event:', data.type);
    
    switch (data.type) {
      case 'connected':
        console.log('Connected to server with ID:', data.data.userId);
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
        
      case 'heartbeat':
        // Keep connection alive
        break;
        
      default:
        console.log('Unknown event type:', data.type);
    }
  };

  const sendSignal = async (type, data = {}, targetUserId = userId) => {
    try {
      console.log('Sending signal:', type, 'for user:', targetUserId);
      
      const response = await fetch(`${SERVER_URL}/api/signal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: targetUserId,
          type: type,
          data: data
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('Server error:', errorData);
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const result = await response.json();
      console.log('Signal sent successfully:', type);
      return result;
    } catch (error) {
      console.error('Error sending signal:', error);
      throw error;
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
      setStatus('Camera and microphone ready!');
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
          console.log('Sending ICE candidate');
          sendSignal('ice-candidate', { candidate: event.candidate }).catch(console.error);
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
      console.log('Sending offer');
      await sendSignal('offer', { offer });
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
      console.log('Sending answer');
      await sendSignal('answer', { answer });
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
    sendSignal('next-user', {}).catch(console.error);
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
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    initializeUser();
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