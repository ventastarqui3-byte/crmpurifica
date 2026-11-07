
// Los sonidos se generan con oscilador (ver createOscillatorSound).
// Antes había aquí 3 MP3 en base64 (SOUNDS) que ningún play* usaba.

// Generar buffers de audio sintéticos para asegurar que el sistema tenga sonidos reales si los Base64 fallan
const createOscillatorSound = (freq: number, type: OscillatorType, duration: number) => {
  try {
    const context = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = context.createOscillator();
    const gain = context.createGain();
    
    osc.type = type;
    osc.frequency.setValueAtTime(freq, context.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, context.currentTime + duration);
    
    gain.gain.setValueAtTime(0.1, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + duration);
    
    osc.connect(gain);
    gain.connect(context.destination);
    
    osc.start();
    osc.stop(context.currentTime + duration);
  } catch (e) {
    console.warn("Audio Context blocked or not supported");
  }
};

class NotificationService {
  private isMuted: boolean = false;

  constructor() {
    this.isMuted = localStorage.getItem('crm_muted') === 'true';

  }

  setMute(mute: boolean) {
    this.isMuted = mute;
    localStorage.setItem('crm_muted', String(mute));
  }

  getMute() {
    return this.isMuted;
  }

  playReceived() {
    if (this.isMuted) return;
    createOscillatorSound(880, 'sine', 0.15); // Un "ding" suave
  }

  playSent() {
    if (this.isMuted) return;
    createOscillatorSound(1200, 'sine', 0.05); // Un "click" rápido
  }

  playAlert() {
    if (this.isMuted) return;
    createOscillatorSound(440, 'triangle', 0.3); // Un tono de aviso
  }
}

export const notificationService = new NotificationService();
