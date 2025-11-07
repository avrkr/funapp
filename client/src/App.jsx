import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
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
  const pendingCandidatesRef = useRef([]);

  useEffect(() => {
    initializeUser();
    
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
    }
  };

  const initializeUser = async () => {
    try {
      setStatus('Getting user ID...');
      
      const response = await fetch(`${SERVER_URL}/api/user-id`);
      const data = await response.json();
      
      const newUserId = data.userId;
      setUserId(newUserId);
      
      await initializeMedia();
      connectEventSource(newUserId);
      
    } catch (error) {
      console.error('Error initializing:', error);
      setStatus('Failed to initialize. Retrying...');
      
      reconnectTimeoutRef.current = setTimeout(() => {
        initializeUser();
      }, 3000);
    }
  };

  const initializeMedia = async () => {
    try {
      setStatus('Requesting camera and microphone...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setStatus('Media ready!');
      return true;
    } catch (error) {
      console.error('Error accessing media:', error);
      setStatus('Error: Cannot access camera/microphone');
      return false;
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
        console.log('✅ EventSource connected');
        setStatus('Connected! Looking for partner...');
        setIsConnected(true);
        
        sendSignal('join', {}, userId);
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleServerEvent(data);
        } catch (error) {
          console.error('Error parsing event:', error);
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
            connectEventSource(userId);
          }, 3000);
        }
      };

    } catch (error) {
      console.error('Error creating EventSource:', error);
    }
  };

  const handleServerEvent = async (data) => {
    console.log('Event:', data.type);
    
    switch (data.type) {
      case 'connected':
        console.log('Connected with ID:', data.data.userId);
        break;
        
      case 'user-connected':
        console.log('Partner found:', data.data.partnerId);
        setPartnerId(data.data.partnerId);
        setStatus('Partner found! Preparing video call...');
        sendSignal('ready', {});
        break;

      case 'start-call':
        console.log('Starting call, initiator:', data.data.initiator);
        setStatus('Setting up video call...');
        await createPeerConnection();
        if (data.data.initiator) {
          await createOffer();
        }
        break;
        
      case 'offer':
        console.log('Received offer');
        setStatus('Incoming call...');
        await createPeerConnection();
        await handleOffer(data.data.offer);
        break;
        
      case 'answer':
        console.log('Received answer');
        await handleAnswer(data.data.answer);
        break;
        
      case 'ice-candidate':
        await handleNewICECandidate(data.data.candidate);
        break;
        
      case 'partner-disconnected':
        console.log('Partner disconnected');
        setStatus('Partner disconnected. Looking for new partner...');
        resetConnection();
        break;
        
      case 'heartbeat':
        break;
        
      default:
        console.log('Unknown event:', data.type);
    }
  };

  const sendSignal = async (type, data = {}, targetUserId = userId) => {
    try {
      await fetch(`${SERVER_URL}/api/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: targetUserId,
          type: type,
          data: data
        })
      });
    } catch (error) {
      console.error('Error sending signal:', error);
    }
  };

  const createPeerConnection = async () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    if (!localStreamRef.current) {
      await initializeMedia();
    }

    try {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });

      pc.ontrack = (event) => {
        console.log('Remote stream received');
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
        setStatus('Video call connected!');
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal('ice-candidate', { candidate: event.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setStatus('Video call connected!');
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setStatus('Connection issue...');
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log('ICE state:', pc.iceConnectionState);
      };

      peerConnectionRef.current = pc;
      pendingCandidatesRef.current = [];
    } catch (error) {
      console.error('Error creating peer connection:', error);
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
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      
      for (const candidate of pendingCandidatesRef.current) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidatesRef.current = [];
      
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
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      
      for (const candidate of pendingCandidatesRef.current) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidatesRef.current = [];
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  };

  const handleNewICECandidate = async (candidate) => {
    if (!peerConnectionRef.current) return;

    try {
      if (peerConnectionRef.current.remoteDescription) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        pendingCandidatesRef.current.push(candidate);
      }
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  };

  const resetConnection = () => {
    setPartnerId('');
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    pendingCandidatesRef.current = [];
  };

  const handleNextUser = () => {
    sendSignal('next-user', {});
    setStatus('Looking for next partner...');
    resetConnection();
  };

  const toggleMedia = (type, enable) => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getTracks().forEach(track => {
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
          <div className="user-id">ID: {userId.substring(0, 8) || '...'}</div>
        </div>
      </div>

      <div className="main-content">
        <div className="video-container">
          <div className="video-wrapper">
            <h3>You</h3>
            <video ref={localVideoRef} autoPlay muted playsInline className="video-element" />
            <div className="video-controls">
              <button onClick={() => toggleMedia('video', false)} className="control-btn">📷 Off</button>
              <button onClick={() => toggleMedia('video', true)} className="control-btn">📷 On</button>
              <button onClick={() => toggleMedia('audio', false)} className="control-btn">🎤 Off</button>
              <button onClick={() => toggleMedia('audio', true)} className="control-btn">🎤 On</button>
            </div>
          </div>

          <div className="video-wrapper">
            <h3>Partner {partnerId && `(${partnerId.substring(0, 8)})`}</h3>
            <video ref={remoteVideoRef} autoPlay playsInline className="video-element" />
            {partnerId && (
              <button onClick={handleNextUser} className="next-btn">🔄 Next</button>
            )}
          </div>
        </div>

        <div className="status-panel">
          <div className="status-message">{status}</div>
        </div>
      </div>
    </div>
  );
}

export default App;