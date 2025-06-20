import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3000;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (clientSocket) => {
  console.log('📞 Client connected');

  const dgSocket = new WebSocket('wss://api.deepgram.com/v1/listen?language=en&punctuate=true', {
    headers: {
      Authorization: `Token ${DEEPGRAM_KEY}`,
    },
  });

  dgSocket.on('open', () => console.log('🔌 Connected to Deepgram'));
  dgSocket.on('message', (data) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data);
    }
  });
  dgSocket.on('close', () => {
    console.log('❌ Deepgram closed');
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
  });

  clientSocket.on('message', (data) => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(data);
    }
  });

  clientSocket.on('close', () => dgSocket.close());
});
