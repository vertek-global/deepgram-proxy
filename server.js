import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import { parse } from 'url';

dotenv.config();

const PORT = process.env.PORT || 3000;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

const wss = new WebSocketServer({ port: PORT });
console.log(`🚀 Proxy server running on port ${PORT}`);

wss.on('connection', (clientSocket, req) => {
  const { pathname } = parse(req.url || '');
  console.log(`🔌 New WebSocket connection to ${pathname}`);

  if (pathname === '/deepgram') {
    const dgSocket = new WebSocket('wss://api.deepgram.com/v1/listen?language=en&punctuate=true', {
      headers: {
        Authorization: `Token ${DEEPGRAM_KEY}`,
      },
    });

    dgSocket.on('open', () => console.log('🎙️ Connected to Deepgram'));
    dgSocket.on('message', (data) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data);
      }
    });
    dgSocket.on('close', () => {
      console.log('❌ Deepgram socket closed');
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    });
    dgSocket.on('error', (err) => console.error('❗ Deepgram error:', err));
    clientSocket.on('message', (data) => {
      if (dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(data);
      }
    });
    clientSocket.on('close', () => {
      console.log('👋 Client socket closed (Deepgram)');
      if (dgSocket.readyState === WebSocket.OPEN) dgSocket.close();
    });
    clientSocket.on('error', (err) => console.error('❗ Client error (Deepgram):', err));

  } else if (pathname?.startsWith('/elevenlabs/')) {
    const voiceId = pathname.split('/')[2];
    if (!voiceId) {
      console.error('❗ No voice ID provided in ElevenLabs route');
      clientSocket.close();
      return;
    }

    const elevenSocket = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/streaming/${voiceId}?optimize_streaming_latency=3`,
      {
        headers: {
          'xi-api-key': ELEVENLABS_KEY,
        },
      }
    );

    elevenSocket.on('open', () => {
      console.log('🗣️ Connected to ElevenLabs');
    });
    elevenSocket.on('message', (data) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data);
      }
    });
    elevenSocket.on('close', () => {
      console.log('🔒 ElevenLabs socket closed');
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    });
    elevenSocket.on('error', (err) => console.error('❗ ElevenLabs error:', err));
    clientSocket.on('message', (data) => {
      if (elevenSocket.readyState === WebSocket.OPEN) {
        elevenSocket.send(data);
      }
    });
    clientSocket.on('close', () => {
      console.log('👋 Client socket closed (ElevenLabs)');
      if (elevenSocket.readyState === WebSocket.OPEN) elevenSocket.close();
    });
    clientSocket.on('error', (err) => console.error('❗ Client error (ElevenLabs):', err));

  } else {
    console.warn('⚠️ Unknown WebSocket route:', pathname);
    clientSocket.close();
  }
});
