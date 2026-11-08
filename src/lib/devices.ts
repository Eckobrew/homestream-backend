import crypto from 'node:crypto';
import { readDevices, writeDevices, deviceHash } from '@/state/database';
export interface PairedDevice {
  deviceId: string; deviceName: string; client: string; pairedAt: string; lastSeen: string;
  pairedLocally: boolean; activeProfileId?: string;
}
const valid = (token: string) => /^hst_dev_[a-f0-9]{48}$/.test(token);
export const loadDevices = () => readDevices<PairedDevice>();
export const saveDevices = (devices: Record<string, PairedDevice>) => writeDevices(devices);
export function registerDevice(deviceId: string, deviceName: string, client = 'android', pairedLocally = true, _forceNew = false): PairedDevice & { token: string } {
  // Raw credentials are returned once. Re-pairing issues a fresh credential.
  const token = `hst_dev_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const device: PairedDevice = { deviceId: deviceId.trim() || crypto.randomUUID(), deviceName: deviceName || 'HomeStream Mobile Device', client, pairedAt: now, lastSeen: now, pairedLocally };
  const devices = loadDevices();
  devices[deviceHash(token)] = device; saveDevices(devices);
  return { ...device, token };
}
export function registeredDevice(token: string): PairedDevice | undefined {
  if (!valid(token)) return;
  const device = loadDevices()[deviceHash(token)];
  return device?.client !== 'android-jellyfin' ? device : undefined;
}
export function isValidDeviceToken(token: string): boolean {
  const device = registeredDevice(token);
  if (!device) return false;
  if (Date.now() - Date.parse(device.lastSeen) > 60000) {
    const devices = loadDevices(); device.lastSeen = new Date().toISOString(); devices[deviceHash(token)] = device; saveDevices(devices);
  }
  return true;
}
export const isLocallyPairedDeviceToken = (token: string) => registeredDevice(token)?.pairedLocally === true;
export function selectDeviceProfile(token: string, profileId: string) {
  const device = registeredDevice(token);
  if (!device) throw new Error('Device not registered');
  const devices = loadDevices(); device.activeProfileId = profileId; devices[deviceHash(token)] = device; saveDevices(devices);
}
