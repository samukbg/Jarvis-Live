import { Modality } from '@google/genai';
import { PHONE_ACTION_PROMPT, PHONE_ACTION_TOOL } from '../../device/phoneActions.js';
import { TranscriptBuffer } from '../transcript.js';
import { acknowledgement } from '../acknowledge.js';

export class GeminiLiveProvider {
  constructor(options) {
    this.createClient = options.createClient;
    this.broadcast = options.broadcast;
    this.broadcastAudioChunk = options.broadcastAudioChunk || (() => {});
    this.broadcastLog = options.broadcastLog;
    this.broadcastNotification = options.broadcastNotification;
    this.broadcastAgentStatus = options.broadcastAgentStatus;
    this.delegateToAgent = options.delegateToAgent;
    this.phoneBridge = options.phoneBridge;
    this.speak = options.speak;
    
    this.session = null;
    this.connecting = false;
    this.geminiState = 'IDLE';
    // Live transcribes in fragments: one line per utterance, not one per fragment.
    this.userSpeech = new TranscriptBuffer();
    this.jarvisSpeech = new TranscriptBuffer();
    // Has Jarvis said anything since the user's last utterance? (else acknowledge a delegation)
    this.saidThisTurn = false;
    this.lastUserUtterance = '';
  }

  /** The user's utterance is over (Jarvis answers, calls a tool, or the turn ends): log it once. */
  flushUserSpeech() {
    const text = this.userSpeech.flush();
    if (!text) return;
    this.lastUserUtterance = text;
    this.saidThisTurn = false;
    this.broadcast({ type: 'voice_transcript', text, role: 'user', is_final: true });
  }

  /** Delegating without a word from Gemini first: Jarvis acknowledges in writing (it can't speak into this session). */
  acknowledgeIfSilent(agentId) {
    if (this.saidThisTurn) return;
    const ack = acknowledgement(agentId, this.lastUserUtterance);
    this.broadcastLog(`JARVIS: ${ack}`);
    this.broadcast({ type: 'voice_transcript', text: ack, role: 'assistant', is_final: true });
    this.saidThisTurn = true;
  }

  async connect(targetAgent = 'agy') {
    if (this.connecting) return;
    
    if (this.session) {
      if (this.targetAgent === targetAgent) return;
      
      // Target agent changed, disconnect first
      this.disconnect();
    }
    
    this.connecting = true;
    this.targetAgent = targetAgent;

    try {
      console.log('[GEMINI] Connecting to Live API...');
      this.broadcastLog('[GEMINI] Initializing Live Session...');
      
      const client = this.createClient();
      
      this.session = await client.live.connect({
        // gemini-3.1-flash-live-preview stopped answering audio on 2026-10-01 (1011 errors).
        model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest',
        config: {
          responseModalities: [Modality.AUDIO],
          // Native-audio models think before answering; a conversation doesn't need it
          // (first audio ~0.5-1 s sooner).
          thinkingConfig: { thinkingBudget: 0 },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore',
              }
            }
          },
          systemInstruction: `You are Jarvis, a concise and helpful AI assistant. Respond naturally and briefly. When the user asks you to perform a computer-use task, browser-use task, run a script, create an app, search something complex, or modify files, DO NOT say you cannot do it. Instead, USE the \`delegate_to_${this.targetAgent}\` tool to delegate the task to the ${this.targetAgent.toUpperCase()} agent.\n\nCRITICAL RULE: Before invoking the \`delegate_to_${this.targetAgent}\` tool, you MUST first speak a short acknowledgment to the user IN THE EXACT SAME LANGUAGE they used (e.g., if English: "Let me check that for you." or "I'm on it.", if Portuguese: "Vou verificar" or "Estou nisso", etc). Do not skip this acknowledgment and NEVER respond in English if the user spoke another language.\n\nOnce the tool returns a result, summarize the findings naturally to the user in their language.\n\n${PHONE_ACTION_PROMPT}`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [{
            functionDeclarations: [{
              name: `delegate_to_${this.targetAgent}`,
              description: `Delegate computer-use, browser-use, scripting, or analysis tasks to the ${this.targetAgent.toUpperCase()} agent.`,
              parameters: {
                type: 'OBJECT',
                properties: {
                  task: {
                    type: 'STRING',
                    description: 'The detailed task instruction to send to the terminal agent'
                  }
                },
                required: ['task']
              }
            }, PHONE_ACTION_TOOL]
          }],
        },
        callbacks: {
          onopen: () => {
            console.log('[GEMINI] Live connected');
            this.broadcastLog('[GEMINI] Live Session Active ●');
            this.broadcastNotification({ label: 'GEMINI LIVE', msg: 'Live voice session connected', kind: 'success' });
          },
          onmessage: async (message) => {
            const sc = message.serverContent;
            // What the user says, as it is recognised (the live caption), then once in full.
            if (sc?.inputTranscription?.text) {
              const text = this.userSpeech.add(sc.inputTranscription.text);
              if (text) this.broadcast({ type: 'voice_transcript', text, role: 'user', is_final: false });
            }
            if (sc?.inputTranscription?.finished) this.flushUserSpeech();
            if (sc?.modelTurn || sc?.outputTranscription || message.toolCall) this.flushUserSpeech();
            if (sc) {
              // Clear audio on interruptions
              if (sc.interrupted) {
                this.jarvisSpeech.flush(); // cut off: the next answer starts a new line
                this.broadcast({ type: 'gemini_live_interrupt' });
                return;
              }
              
              // Stream raw PCM audio to frontend
              if (sc.modelTurn?.parts) {
                if (this.geminiState !== 'THINKING' && this.broadcastAgentStatus) {
                  this.geminiState = 'THINKING';
                  this.broadcastAgentStatus(this.targetAgent, 'THINKING');
                }
                for (const part of sc.modelTurn.parts) {
                  if (part.inlineData?.data) {
                    this.saidThisTurn = true; // Jarvis is speaking
                    try {
                      const rawPcm = Buffer.from(part.inlineData.data, 'base64');
                      this.broadcastAudioChunk(rawPcm);
                    } catch (e) {}
                    this.broadcast({
                      type: 'tts_chunk',
                      content: part.inlineData.data,
                      isPcm: true,
                      format: 'pcm'
                    });
                  }
                }
              }
              
              // Show Gemini's spoken transcript in the UI
              if (sc.outputTranscription?.text) {
                this.saidThisTurn = true;
                const text = this.jarvisSpeech.add(sc.outputTranscription.text);
                if (text) this.broadcast({ type: 'voice_transcript', text, role: 'assistant', is_final: false });
              }
            }

            if (message.toolCall) {
              const fc = message.toolCall.functionCalls?.[0];
              if (fc && fc.name === PHONE_ACTION_TOOL.name) {
                // Runs on the phone; Gemini speaks the result.
                (async () => {
                  const result = this.phoneBridge
                    ? await this.phoneBridge.run(fc.args || {})
                    : 'Phone actions are not available.';
                  try {
                    this.session?.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: fc.name, response: { result } }],
                    });
                  } catch (e) {
                    this.broadcastLog(`[GEMINI ERROR] Phone action response failed: ${e.message}`);
                  }
                })();
              } else if (fc && fc.name === `delegate_to_${this.targetAgent}`) {
                const task = fc.args.task;
                this.acknowledgeIfSilent(this.targetAgent);
                this.broadcastLog(`[GEMINI LIVE] Delegating to ${this.targetAgent.toUpperCase()}: ${task}`);
                
                // Execute without blocking the event loop or audio stream
                (async () => {
                  const rawResultText = await this.delegateToAgent(task, this.targetAgent, true);
                  const resultText = (rawResultText && rawResultText.length > 5000) 
                    ? rawResultText.substring(0, 5000) + '... [TRUNCATED DUE TO LENGTH]' 
                    : rawResultText;
                  
                  try {
                    console.log(`[GEMINI LIVE] Sending tool response for ${fc.name}... length: ${resultText?.length || 0}`);
                    if (this.session?.sendToolResponse) {
                      this.session.sendToolResponse({
                        functionResponses: [{
                          id: fc.id,
                          name: fc.name,
                          response: { result: resultText }
                        }]
                      });
                    } else if (this.session) {
                      this.session.send({
                        clientContent: {
                          turnComplete: true,
                          toolResponse: {
                            functionResponses: [{
                              id: fc.id,
                              name: fc.name,
                              response: { result: resultText }
                            }]
                          }
                        }
                      });
                    }
                    console.log(`[GEMINI LIVE] Tool response sent successfully.`);
                  } catch (e) {
                    console.error(`[GEMINI LIVE] Failed to send tool response:`, e);
                    this.broadcastLog(`[GEMINI ERROR] Tool Response Failed: ${e.message}`);
                  }
                })();
              }
            }


            
            if (sc?.turnComplete) {
              this.flushUserSpeech();
              const said = this.jarvisSpeech.flush();
              if (said) this.broadcast({ type: 'voice_transcript', text: said, role: 'assistant', is_final: true });
              if (this.broadcastAgentStatus) {
                this.geminiState = 'IDLE';
                this.broadcastAgentStatus(this.targetAgent, 'IDLE');
              }
            }
          },
          onerror: (e) => {
            console.error('[GEMINI] Error:', e.message);
            this.broadcastLog(`[GEMINI ERROR] ${e.message}`);
            this.broadcastNotification({ label: 'GEMINI LIVE', msg: `Error: ${e.message}`, kind: 'warn' });
            this.session = null;
          },
          onclose: (e) => {
            const closeMsg = `[GEMINI] Live Session Closed — code:${e.code} reason:${e.reason || 'none'}`;
            console.log(closeMsg);
            this.broadcastLog(closeMsg);
            this.session = null;
          }
        }
      });
    } catch (err) {
      console.error('[GEMINI] Connection failed:', err.message);
      this.broadcastLog(`[GEMINI] Connection failed: ${err.message}`);
      this.broadcastNotification({ label: 'GEMINI LIVE', msg: `Connection failed: ${err.message}`, kind: 'warn' });
      if (this.broadcastAgentStatus) this.broadcastAgentStatus(this.targetAgent || 'gemini', 'IDLE');
    } finally {
      this.connecting = false;
    }
  }

  disconnect() {
    if (this.session) {
      console.log('[GEMINI] Closing Live session');
      this.broadcastLog('[GEMINI] Live Session Closing...');
      if (typeof this.session.close === 'function') {
        try { this.session.close(); } catch(e) {}
      }
      this.session = null;
      if (this.broadcastAgentStatus) this.broadcastAgentStatus(this.targetAgent || 'gemini', 'IDLE');
    }
    this.connecting = false;
  }
}
