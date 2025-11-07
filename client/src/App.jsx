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
  const userIdRef = useRef('');
  const iceCandidatesQueue = useRef([]);

  useEffect(() => {
    initApp();
    return cleanup;
  }, []);

  const cleanup = () => {
    if (eventSourceRef.current) eventSourceRef.current.close();
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
    }
  };

  const initApp = async () => {
    try {
      setStatus('Initializing...');
      
      const res = await fetch(`${SERVER_URL}/api/user-id`);
      const { userId: newId } = await res.json();
      
      setUserId(newId);
      userIdRef.current = newId;
      
      await getMedia();
      connectEvents(newId);
      
    } catch (err) {
      console.error('Init error:', err);
      setStatus('Failed. Retrying...');
      setTimeout(initApp, 3000);
    }
  };

  const getMedia = async () => {
    try {
      setStatus('Getting camera...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setStatus('Camera ready');
      return true;
    } catch (err) {
      console.error('Media error:', err);
      setStatus('Camera access denied');
      return false;
    }
  };

  const connectEvents = (uid) => {
    if (eventSourceRef.current) eventSourceRef.current.close();

    setStatus('Connecting...');
    
    const es = new EventSource(`${SERVER_URL}/api/events?userId=${uid}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      console.log('Connected to server');
      setStatus('Waiting for partner...');
      setIsConnected(true);
    };

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleEvent(msg);
      } catch (err) {
        console.error('Parse error:', err);
      }
    };

    es.onerror = () => {
      console.error('Connection lost');
      setStatus('Reconnecting...');
      setIsConnected(false);
      es.close();
      setTimeout(() => connectEvents(uid), 3000);
    };
  };

  const handleEvent = async (msg) => {
    console.log('Event:', msg.type);
    
    switch (msg.type) {
      case 'connected':
        console.log('Server confirmed:', msg.userId);
        break;

      case 'partner-found':
        console.log('Partner:', msg.partnerId);
        setPartnerId(msg.partnerId);
        setStatus('Partner found! Setting up...');
        signal('ready');
        break;

      case 'start-call':
        console.log('Start call, initiator:', msg.initiator);
        setStatus('Connecting video...');
        await setupPeer();
        if (msg.initiator) {
          await makeOffer();
        }
        break;

      case 'offer':
        console.log('Got offer');
        await setupPeer();
        await handleOffer(msg.offer);
        break;

      case 'answer':
        console.log('Got answer');
        await handleAnswer(msg.answer);
        break;

      case 'ice-candidate':
        await handleIce(msg.candidate);
        break;

      case 'partner-disconnected':
        console.log('Partner left');
        setStatus('Partner left. Finding new...');
        reset();
        break;

      case 'heartbeat':
        break;
    }
  };

  const signal = async (type, data = {}) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userIdRef.current,
          type,
          data
        })
      });
      
      if (!res.ok) {
        const err = await res.text();
        console.error('Signal error:', err);
      }
    } catch (err) {
      console.error('Signal failed:', err);
    }
  };

  const setupPeer = async () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    
    localStreamRef.current.getTracks().forEach(track => {
      pc.addTrack(track, localStreamRef.current);
    });

    pc.ontrack = (e) => {
      console.log('Remote track received');
      if (remoteVideoRef.current && e.streams[0]) {
        remoteVideoRef.current.srcObject = e.streams[0];
        setStatus('Connected!');
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signal('ice-candidate', { candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('ICE:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected') {
        setStatus('Video connected!');
      } else if (pc.iceConnectionState === 'failed') {
        setStatus('Connection failed');
      }
    };

    peerConnectionRef.current = pc;
    iceCandidatesQueue.current = [];
  };

  const makeOffer = async () => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('Sending offer');
      await signal('offer', { offer });
    } catch (err) {
      console.error('Offer error:', err);
    }
  };

  const handleOffer = async (offer) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      for (const ice of iceCandidatesQueue.current) {
        await pc.addIceCandidate(new RTCIceCandidate(ice));
      }
      iceCandidatesQueue.current = [];
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('Sending answer');
      await signal('answer', { answer });
    } catch (err) {
      console.error('Offer handle error:', err);
    }
  };

  const handleAnswer = async (answer) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      
      for (const ice of iceCandidatesQueue.current) {
        await pc.addIceCandidate(new RTCIceCandidate(ice));
      }
      iceCandidatesQueue.current = [];
    } catch (err) {
      console.error('Answer handle error:', err);
    }
  };

  const handleIce = async (candidate) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    try {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        iceCandidatesQueue.current.push(candidate);
      }
    } catch (err) {
      console.error('ICE error:', err);
    }
  };

  const reset = () => {
    setPartnerId('');
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    iceCandidatesQueue.current = [];
  };

  const nextUser = () => {
    signal('next');
    setStatus('Finding next...');
    reset();
  };

  const toggleTrack = (kind, enabled) => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getTracks().forEach(t => {
      if (t.kind === kind) t.enabled = enabled;
    });
  };

  return (
    <div className="app">
      <div className="header">
        <h1>Random Video Chat</h1>
        <div className="status">
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '● Online' : '● Offline'}
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
              <button onClick={() => toggleTrack('video', true)}>📹 On</button>
              <button onClick={() => toggleTrack('video', false)}>📹 Off</button>
              <button onClick={() => toggleTrack('audio', true)}>🎤 On</button>
              <button onClick={() => toggleTrack('audio', false)}>🎤 Off</button>
            </div>
          </div>

          <div className="video-wrapper">
            <h3>Partner {partnerId && `(${partnerId.substring(0, 8)})`}</h3>
            <video ref={remoteVideoRef} autoPlay playsInline className="video-element" />
            {partnerId && (
              <button onClick={nextUser} className="next-btn">⏭️ Next</button>
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