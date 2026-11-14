export interface ZoomRange {
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface CameraHandle {
  stream: MediaStream;
  track: MediaStreamTrack;
  torchSupported: boolean;
  /** Rango de zoom óptico/digital de la cámara, si el navegador lo expone (Android Chrome sí). */
  zoom: ZoomRange | null;
}

type ExtraCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  zoom?: { min: number; max: number; step?: number };
  focusMode?: string[];
};

function describe(e: unknown): string {
  const err = e as DOMException | Error;
  const name = (err as DOMException).name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return 'Permiso de cámara denegado. Actívalo en los ajustes del navegador para este sitio.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No se encontró ninguna cámara.';
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'La cámara está ocupada por otra aplicación.';
  if (name === 'OverconstrainedError') return 'La cámara no soporta la configuración pedida.';
  if (name === 'SecurityError') return 'La cámara solo funciona en HTTPS (o en localhost).';
  return err?.message || 'No se pudo abrir la cámara.';
}

export interface CameraOptions {
  zoom?: number | null;
  res?: '1080p' | '4k';
}

export async function startCamera(video: HTMLVideoElement, opts: CameraOptions = {}): Promise<CameraHandle> {
  const initialZoom = opts.zoom;
  const ideal = opts.res === '4k' ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 };
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      window.isSecureContext
        ? 'Este navegador no permite usar la cámara.'
        : 'La cámara solo funciona en HTTPS (o en localhost).',
    );
  }
  const attempts: MediaStreamConstraints[] = [
    {
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: ideal.width }, height: { ideal: ideal.height } },
    },
    { audio: false, video: { facingMode: 'environment' } },
    { audio: false, video: true },
  ];
  let stream: MediaStream | null = null;
  let lastErr: unknown = null;
  for (const c of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) {
      lastErr = e;
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') break;
    }
  }
  if (!stream) throw new Error(describe(lastErr));

  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', 'true');
  try {
    await video.play();
  } catch {
    // algunos navegadores lanzan AbortError si el elemento se desmonta; no es fatal
  }
  const track = stream.getVideoTracks()[0];
  const caps = (track.getCapabilities ? track.getCapabilities() : {}) as ExtraCapabilities;

  // Enfoque continuo: el texto pequeño de la esquina lo necesita.
  if (caps.focusMode?.includes('continuous')) {
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet] });
    } catch {
      // no pasa nada
    }
  }

  let zoom: ZoomRange | null = null;
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const current = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom ?? caps.zoom.min;
    zoom = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: current };
    if (initialZoom != null && initialZoom >= zoom.min && initialZoom <= zoom.max && initialZoom !== current) {
      const h = { stream, track, torchSupported: false, zoom };
      if (await setZoom(h, initialZoom)) zoom.value = initialZoom;
    }
  }
  return { stream, track, torchSupported: Boolean(caps.torch), zoom };
}

export function stopCamera(h: CameraHandle | null | undefined): void {
  h?.stream.getTracks().forEach((t) => t.stop());
}

export async function setTorch(h: CameraHandle, on: boolean): Promise<boolean> {
  try {
    await h.track.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

export async function setZoom(h: CameraHandle, value: number): Promise<boolean> {
  if (!h.zoom) return false;
  const v = Math.min(h.zoom.max, Math.max(h.zoom.min, value));
  try {
    await h.track.applyConstraints({ advanced: [{ zoom: v } as unknown as MediaTrackConstraintSet] });
    h.zoom.value = v;
    return true;
  } catch {
    return false;
  }
}
