import express from 'express';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import http from 'http';
import { parse } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL;

app.use(express.json());

// Multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Upload pre-recorded audio to Deepgram with callback URL
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      console.warn('⚠️ /upload-audio called without audio file');
      return res.status(400).send('No audio file uploaded.');
    }

    const callbackUrl = `${SERVER_BASE_URL}/deepgram-callback`;
    console.log(`📤 Uploading audio to Deepgram with callback URL: ${callbackUrl}`);

    const response = await fetch(
      `https://api.deepgram.com/v1/listen?callback=${encodeURIComponent(callbackUrl)}&punctuate=true&language=en`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${DEEPGRAM_KEY}`,
          'Content-Type': req.file.mimetype,
        },
        body: req.file.buffer,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error('❌ Deepgram upload error:', text);
      return res.status(500).send(text);
    }

    const json = await response.json();
    console.log('✅ Deepgram accepted audio, request_id:', json.request_id);
    res.json({ request_id: json.request_id });
  } catch (err) {
    console.error('🔥 Upload error:', err);
    res.status(500).send('Server error uploading audio');
  }
});

// Endpoint for Deepgram transcription callbacks
app.post('/deepgram-callback', async (req, res) => {
  try {
    console.log('📥 Received Deepgram callback with body:', JSON.stringify(req.body));

    const transcription = req.body?.channel?.alternatives?.[0]?.transcript;
    if (!transcription) {
      console.warn('⚠️ No transcription found in callback');
      return res.status(400).send('No transcription');
    }

    console.log('📝 Transcription from Deepgram callback:', transcription);

    // Call OpenAI GPT
    const gptResponse = await sendToGPT(transcription);
    console.log('🤖 GPT response:', gptResponse);

    // TODO: Store or send gptResponse to client via WebSocket or other means

    res.status(200).send('OK');
  } catch (err) {
    console.error('🔥 Callback handling error:', err);
    res.status(500).send('Server error');
  }
});

// Setup WebSocket server for streaming proxy
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  const pathname = parse(req.url || '').pathname || '';
  console.log(`🔌 WS connection established on path: ${pathname}`);

  if (pathname === '/deepgram-stream') {
    console.log('🌊 Proxying audio stream to Deepgram');
    const dgSocket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?language=en&punctuate=true',
      { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } }
    );

    dgSocket.on('open', () => console.log('✅ Connected to Deepgram WS'));
    dgSocket.on('message', (msg) => {
      console.log('⬅️ Received message from Deepgram WS, forwarding to client');
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
    dgSocket.on('close', () => {
      console.log('❌ Deepgram WS closed, closing client WS');
      ws.close();
    });
    dgSocket.on('error', (err) => {
      console.error('🔥 Deepgram WS error:', err);
      ws.close();
    });

    ws.on('message', (msg) => {
      console.log('➡️ Received audio chunk from client, sending to Deepgram');
      if (dgSocket.readyState === WebSocket.OPEN) dgSocket.send(msg);
    });
    ws.on('close', () => {
      console.log('👋 Client WS closed, closing Deepgram WS');
      if (dgSocket.readyState === WebSocket.OPEN) dgSocket.close();
    });
    ws.on('error', (err) => console.error('🔥 Client WS error:', err));

  } else if (pathname.startsWith('/elevenlabs-stream/')) {
    const voiceId = pathname.split('/')[2];
    console.log(`🎙️ Proxying TTS stream to ElevenLabs with voice ID: ${voiceId}`);

    if (!voiceId) {
      console.error('❌ No voice ID in ElevenLabs stream URL');
      ws.close();
      return;
    }

    const elSocket = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/streaming/${voiceId}?optimize_streaming_latency=3`,
      { headers: { 'xi-api-key': ELEVENLABS_KEY } }
    );

    elSocket.on('open', () => console.log('✅ Connected to ElevenLabs WS'));
    elSocket.on('message', (msg) => {
      console.log('⬅️ Received audio chunk from ElevenLabs, forwarding to client');
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
    elSocket.on('close', () => {
      console.log('🔒 ElevenLabs WS closed, closing client WS');
      ws.close();
    });
    elSocket.on('error', (err) => {
      console.error('🔥 ElevenLabs WS error:', err);
      ws.close();
    });

    ws.on('message', (msg) => {
      console.log('➡️ Received text chunk from client, sending to ElevenLabs');
      if (elSocket.readyState === WebSocket.OPEN) elSocket.send(msg);
    });
    ws.on('close', () => {
      console.log('👋 Client WS closed, closing ElevenLabs WS');
      if (elSocket.readyState === WebSocket.OPEN) elSocket.close();
    });
    ws.on('error', (err) => console.error('🔥 Client WS error:', err));

  } else {
    console.warn('⚠️ Unknown WS route:', pathname);
    ws.close();
  }
});

// OpenAI GPT helper function
async function sendToGPT(prompt) {
  try {
    console.log('🧠 Sending prompt to OpenAI GPT:', prompt);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('❌ OpenAI API error:', text);
      return '';
    }

    const json = await response.json();
    console.log('🧠 OpenAI GPT response:', json.choices[0].message.content);
    return json.choices[0].message.content;
  } catch (err) {
    console.error('🔥 OpenAI call failed:', err);
    return '';
  }
}

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
