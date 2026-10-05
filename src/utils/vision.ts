export class VisionCapture {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private intervalId: any = null;
  private isScreen: boolean = false;

  constructor(isScreen = false) {
    this.isScreen = isScreen;
  }

  async start(onFrame: (base64Jpeg: string) => void, fps = 1) {
    if (this.stream) return;
    try {
      this.stream = this.isScreen 
        ? await navigator.mediaDevices.getDisplayMedia({ video: true })
        : await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      
      this.video = document.createElement('video');
      this.video.srcObject = this.stream;
      this.video.autoplay = true;
      this.video.muted = true;
      // Create a container if it doesn't exist to elegantly stack multiple overlays
      let container = document.getElementById('jarvis-vision-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'jarvis-vision-container';
        container.style.position = 'fixed';
        container.style.bottom = '80px';
        container.style.right = '20px';
        container.style.display = 'flex';
        container.style.flexDirection = 'column-reverse'; // stack from bottom upwards
        container.style.gap = '20px';
        container.style.zIndex = '9999';
        container.style.pointerEvents = 'none';
        container.style.alignItems = 'flex-end'; // right align the videos
        document.body.appendChild(container);
      }

      // Add a stylish overlay for the vision stream!
      this.video.style.width = this.isScreen ? '480px' : '270px'; // 16:9 for screen, 9:16 for camera
      this.video.style.height = this.isScreen ? '270px' : '480px';
      this.video.style.objectFit = 'cover';
      this.video.style.borderRadius = '12px';
      this.video.style.border = '2px solid rgba(34,211,238,0.5)';
      this.video.style.boxShadow = '0 0 20px rgba(34,211,238,0.2)';
      container.appendChild(this.video);

      this.video.play();

      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');

      this.intervalId = setInterval(() => {
        if (!this.video || !this.canvas || !this.ctx) return;
        if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
          this.canvas.width = this.video.videoWidth;
          this.canvas.height = this.video.videoHeight;
          this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
          // Get base64 string (strip the data:image/jpeg;base64, prefix)
          const dataUrl = this.canvas.toDataURL('image/jpeg', 0.6);
          const base64 = dataUrl.split(',')[1];
          onFrame(base64);
        }
      }, 1000 / fps);
      
      return true;
    } catch (e) {
      console.error('VisionCapture error:', e);
      return false;
    }
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
    }
    if (this.video && this.video.parentNode) {
      this.video.parentNode.removeChild(this.video);
    }
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
  }
}
