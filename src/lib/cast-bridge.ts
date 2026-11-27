import tls from 'node:tls';
import crypto from 'node:crypto';

export const DEFAULT_CAST_RECEIVER_ID = 'CC1AD845';

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

export interface CastBridgeDevice {
  id: string;
  name: string;
  host: string;
  port: number;
  source: 'configured' | 'discovered';
}

export interface CastBridgeStatus {
  connected: boolean;
  deviceId?: string;
  deviceName?: string;
  playerState?: 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';
  currentTime?: number;
  duration?: number;
  volume?: number;
  muted?: boolean;
  title?: string;
}

export interface CastMessage {
  protocolVersion: number;
  sourceId: string;
  destinationId: string;
  namespace: string;
  payloadType: number;
  payloadUtf8: string;
}

export function resolveBridgeReceiverId(configured = process.env.CAST_BRIDGE_RECEIVER_APP_ID): string {
  const trimmed = (configured || '').trim().toUpperCase();
  return /^[A-F0-9]{8}$/.test(trimmed) ? trimmed : DEFAULT_CAST_RECEIVER_ID;
}

/** Parse CAST_BRIDGE_DEVICES="Living Room TV=192.168.1.42,Bedroom=192.168.1.43:8009" */
export function parseConfiguredCastDevices(raw = process.env.CAST_BRIDGE_DEVICES || ''): CastBridgeDevice[] {
  const devices: CastBridgeDevice[] = [];
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const eqIdx = entry.indexOf('=');
    const name = eqIdx > 0 ? entry.slice(0, eqIdx).trim() : entry.trim();
    const hostPort = (eqIdx > 0 ? entry.slice(eqIdx + 1) : entry).trim();
    if (!hostPort) continue;
    const colonIdx = hostPort.lastIndexOf(':');
    let host = hostPort;
    let port = 8009;
    if (colonIdx > 0 && /^\d+$/.test(hostPort.slice(colonIdx + 1))) {
      host = hostPort.slice(0, colonIdx).trim();
      port = Number(hostPort.slice(colonIdx + 1));
    }
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const id = `cfg-${crypto.createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0, 12)}`;
    devices.push({ id, name: name || host, host, port, source: 'configured' });
  }
  return devices;
}

// --- Minimal CastV2 Protobuf Wire Encoder / Decoder ---

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeStringField(fieldNum: number, value: string): Buffer {
  const data = Buffer.from(value, 'utf8');
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

function encodeVarintField(fieldNum: number, value: number): Buffer {
  const tag = encodeVarint((fieldNum << 3) | 0);
  return Buffer.concat([tag, encodeVarint(value)]);
}

export function encodeCastMessage(msg: CastMessage): Buffer {
  const body = Buffer.concat([
    encodeVarintField(1, msg.protocolVersion),
    encodeStringField(2, msg.sourceId),
    encodeStringField(3, msg.destinationId),
    encodeStringField(4, msg.namespace),
    encodeVarintField(5, msg.payloadType),
    encodeStringField(6, msg.payloadUtf8),
  ]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function decodeCastMessage(buf: Buffer): CastMessage {
  let offset = 0;
  let protocolVersion = 0;
  let sourceId = '';
  let destinationId = '';
  let namespace = '';
  let payloadType = 0;
  let payloadUtf8 = '';

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    while (offset < buf.length) {
      const byte = buf[offset++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  };

  while (offset < buf.length) {
    const tag = readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      const val = readVarint();
      if (fieldNum === 1) protocolVersion = val;
      else if (fieldNum === 5) payloadType = val;
    } else if (wireType === 2) {
      const len = readVarint();
      const slice = buf.subarray(offset, offset + len).toString('utf8');
      offset += len;
      if (fieldNum === 2) sourceId = slice;
      else if (fieldNum === 3) destinationId = slice;
      else if (fieldNum === 4) namespace = slice;
      else if (fieldNum === 6) payloadUtf8 = slice;
    } else {
      break;
    }
  }
  return { protocolVersion, sourceId, destinationId, namespace, payloadType, payloadUtf8 };
}

export class CastBridgeClient {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private reqId = 1;
  private senderId = `sender-${crypto.randomBytes(4).toString('hex')}`;
  private transportId = '';
  private sessionId = '';
  private mediaSessionId: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<number, (payload: Record<string, unknown>) => void>();

  public device: CastBridgeDevice | null = null;
  public status: CastBridgeStatus = { connected: false };

  async connect(device: CastBridgeDevice): Promise<void> {
    this.disconnect();
    this.device = device;
    this.transportId = '';
    this.sessionId = '';
    this.mediaSessionId = null;

    await new Promise<void>((resolve, reject) => {
      const sock = tls.connect(
        { host: device.host, port: device.port, rejectUnauthorized: false },
        () => resolve()
      );
      sock.setTimeout(8000, () => {
        sock.destroy(new Error('Chromecast connection timed out'));
      });
      sock.once('error', reject);
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('close', () => {
        this.cleanupTimers();
        this.status = { connected: false };
      });
      this.socket = sock;
    });

    this.sendRaw('receiver-0', NS_CONNECTION, { type: 'CONNECT' });
    this.status = { connected: true, deviceId: device.id, deviceName: device.name, playerState: 'IDLE' };

    this.heartbeatTimer = setInterval(() => {
      try {
        this.sendRaw('receiver-0', NS_HEARTBEAT, { type: 'PING' });
      } catch {
        // Ignore heartbeat errors on closing socket.
      }
    }, 5000);
    this.heartbeatTimer.unref?.();
  }

  async launchAndLoad(opts: {
    contentUrl: string;
    contentType: string;
    title: string;
    artworkUrl?: string;
    currentTime?: number;
    receiverAppId?: string;
  }): Promise<CastBridgeStatus> {
    const appId = opts.receiverAppId || resolveBridgeReceiverId();
    const launchResp = await this.sendRequest('receiver-0', NS_RECEIVER, {
      type: 'LAUNCH',
      appId,
    });

    const apps = ((launchResp.status as Record<string, unknown> | undefined)?.applications as Array<Record<string, unknown>> | undefined) || [];
    const app = apps.find((a) => a.appId === appId) || apps[0];
    if (!app || typeof app.transportId !== 'string') {
      throw new Error('Failed to launch Cast receiver application');
    }
    this.transportId = app.transportId;
    this.sessionId = typeof app.sessionId === 'string' ? app.sessionId : '';
    this.sendRaw(this.transportId, NS_CONNECTION, { type: 'CONNECT' });

    const media: Record<string, unknown> = {
      contentId: opts.contentUrl,
      streamType: 'BUFFERED',
      contentType: opts.contentType || 'application/x-mpegURL',
      metadata: {
        metadataType: 0,
        title: opts.title || 'HomeStream',
        ...(opts.artworkUrl ? { images: [{ url: opts.artworkUrl }] } : {}),
      },
    };

    const loadResp = await this.sendRequest(this.transportId, NS_MEDIA, {
      type: 'LOAD',
      media,
      autoplay: true,
      currentTime: Math.max(0, opts.currentTime || 0),
    });

    this.updateMediaStatus(loadResp);
    this.status.title = opts.title;
    return this.status;
  }

  async control(action: 'play' | 'pause' | 'seek' | 'volume' | 'mute' | 'stop', value?: number | boolean): Promise<CastBridgeStatus> {
    if (!this.socket || !this.status.connected) {
      throw new Error('No active Chromecast bridge session');
    }

    if (action === 'volume' && typeof value === 'number') {
      const level = Math.max(0, Math.min(1, value));
      await this.sendRequest('receiver-0', NS_RECEIVER, { type: 'SET_VOLUME', volume: { level } });
      this.status.volume = level;
      return this.status;
    }

    if (action === 'mute' && typeof value === 'boolean') {
      await this.sendRequest('receiver-0', NS_RECEIVER, { type: 'SET_VOLUME', volume: { muted: value } });
      this.status.muted = value;
      return this.status;
    }

    if (action === 'stop') {
      if (this.sessionId) {
        await this.sendRequest('receiver-0', NS_RECEIVER, { type: 'STOP', sessionId: this.sessionId }).catch(() => {});
      }
      this.disconnect();
      return this.status;
    }

    if (!this.transportId || this.mediaSessionId === null) {
      throw new Error('No active media session on Chromecast');
    }

    if (action === 'play') {
      const resp = await this.sendRequest(this.transportId, NS_MEDIA, { type: 'PLAY', mediaSessionId: this.mediaSessionId });
      this.updateMediaStatus(resp);
    } else if (action === 'pause') {
      const resp = await this.sendRequest(this.transportId, NS_MEDIA, { type: 'PAUSE', mediaSessionId: this.mediaSessionId });
      this.updateMediaStatus(resp);
    } else if (action === 'seek' && typeof value === 'number') {
      const resp = await this.sendRequest(this.transportId, NS_MEDIA, {
        type: 'SEEK',
        mediaSessionId: this.mediaSessionId,
        currentTime: Math.max(0, value),
      });
      this.updateMediaStatus(resp);
    }
    return this.status;
  }

  disconnect(): void {
    this.cleanupTimers();
    for (const resolve of this.pending.values()) {
      resolve({});
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.status = { connected: false };
    this.device = null;
    this.transportId = '';
    this.sessionId = '';
    this.mediaSessionId = null;
  }

  private cleanupTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendRaw(destinationId: string, namespace: string, payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) throw new Error('Chromecast socket is not connected');
    const frame = encodeCastMessage({
      protocolVersion: 0,
      sourceId: this.senderId,
      destinationId,
      namespace,
      payloadType: 0,
      payloadUtf8: JSON.stringify(payload),
    });
    this.socket.write(frame);
  }

  private sendRequest(destinationId: string, namespace: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = this.reqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Chromecast request ${String(payload.type)} timed out`));
      }, 8000);
      this.pending.set(requestId, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      try {
        this.sendRaw(destinationId, namespace, { ...payload, requestId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const frame = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      try {
        const msg = decodeCastMessage(frame);
        const parsed = JSON.parse(msg.payloadUtf8) as Record<string, unknown>;
        if (msg.namespace === NS_HEARTBEAT && parsed.type === 'PING') {
          this.sendRaw(msg.sourceId, NS_HEARTBEAT, { type: 'PONG' });
          continue;
        }
        if (msg.namespace === NS_MEDIA && parsed.type === 'MEDIA_STATUS') {
          this.updateMediaStatus(parsed);
        }
        if (typeof parsed.requestId === 'number' && this.pending.has(parsed.requestId)) {
          const cb = this.pending.get(parsed.requestId);
          this.pending.delete(parsed.requestId);
          cb?.(parsed);
        }
      } catch {
        // Ignore malformed frames without logging raw Cast payloads.
      }
    }
  }

  private updateMediaStatus(payload: Record<string, unknown>): void {
    const list = payload.status as Array<Record<string, unknown>> | undefined;
    const first = list?.[0];
    if (!first) return;
    if (typeof first.mediaSessionId === 'number') {
      this.mediaSessionId = first.mediaSessionId;
    }
    if (typeof first.playerState === 'string') {
      this.status.playerState = first.playerState as CastBridgeStatus['playerState'];
    }
    if (typeof first.currentTime === 'number') {
      this.status.currentTime = first.currentTime;
    }
    const media = first.media as Record<string, unknown> | undefined;
    if (typeof media?.duration === 'number') {
      this.status.duration = media.duration;
    }
  }
}

export const sharedCastBridge = new CastBridgeClient();
