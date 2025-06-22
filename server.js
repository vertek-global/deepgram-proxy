import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

wss.on('connection', async (client) => {
  console.log('🔌 Client connected to /voice-stream');

  const dgSocket = new WebSocket('wss://api.deepgram.com/v1/listen?language=en&punctuate=true&encoding=linear16', {
    headers: { Authorization: `Token ${DEEPGRAM_KEY}` },
  });

  dgSocket.on('open', () => console.log('✅ Connected to Deepgram'));

  dgSocket.on('message', async (msg) => {
    const raw = msg.toString();
    console.log('🎧 Deepgram raw message:', raw);

    try {
      const json = JSON.parse(raw);
      const text = json.channel?.alternatives?.[0]?.transcript?.trim();

      if (text) {
        console.log('📝 Deepgram transcript:', text);
        const gptStream = await getGPTStream(text);
        if (gptStream) {
          await streamToElevenLabs(gptStream, client);
        }
      } else {
        console.log('ℹ️ No transcript in this Deepgram message');
      }
    } catch (err) {
      console.error('⚠️ Failed to parse Deepgram message:', err);
    }
  });

  dgSocket.on('error', (err) => {
    console.error('🔥 Deepgram socket error:', err);
  });

  dgSocket.on('close', () => {
    console.log('❌ Deepgram socket closed');
  });

  client.on('message', (audio) => {
    if (dgSocket.readyState === WebSocket.OPEN) {
      console.log('📥 Received audio chunk of size:', audio.byteLength || audio.length);
      dgSocket.send(audio);
    }
  });

  client.on('close', () => {
    console.log('👋 Client disconnected');
    if (dgSocket.readyState === WebSocket.OPEN) dgSocket.close();
  });

  client.on('error', (err) => {
    console.error('🔥 Client WS error:', err);
  });
});

async function getGPTStream(userInput) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        messages: [
          {
            role: 'system',
            content: "You are Todd’s executive assistant. Respond naturally, concisely, and warmly.",
          },
          { role: 'user', content: userInput },
        ],
      }),
    });

    return res.body?.getReader();
  } catch (err) {
    console.error('🧠 GPT fetch error:', err);
    return null;
  }
}

async function streamToElevenLabs(reader, client) {
  const elSocket = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/streaming/${ELEVENLABS_VOICE_ID}?optimize_streaming_latency=3`,
    { headers: { 'xi-api-key': ELEVENLABS_KEY } }
  );

  elSocket.on('open', async () => {
    console.log('🗣️ ElevenLabs connected');

    elSocket.send(
      JSON.stringify({
        text: ' ',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        model_id: 'eleven_multilingual_v2',
      })
    );

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const payload = line.replace('data: ', '');
          if (payload === '[DONE]') {
            elSocket.close();
            return;
          }

          try {
            const data = JSON.parse(payload);
            const token = data.choices?.[0]?.delta?.content;
            if (token && elSocket.readyState === WebSocket.OPEN) {
              elSocket.send(JSON.stringify({ text: token }));
            }
          } catch (err) {
            console.error('⚠️ Failed to parse GPT token:', err);
          }
        }
      }
    } catch (err) {
      console.error('📡 Stream error while reading GPT stream:', err);
    } finally {
      elSocket.close();
    }
  });

  elSocket.on('message', (audio) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(audio);
    }
  });

  elSocket.on('close', () => {
    console.log('🔇 ElevenLabs socket closed');
  });

  elSocket.on('error', (err) => {
    console.error('🔥 ElevenLabs WS error:', err);
  });
}

server.listen(PORT, () => {
  console.log(`🚀 Server live on port ${PORT}`);
});
