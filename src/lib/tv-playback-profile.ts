export interface TvVideoCapability {
  codec: string;
  width: number;
  height: number;
  profiles: string[];
}

/** Bounded device input: never pass arbitrary profile conditions to the media engine. */
export function parseTvCapabilities(raw: string | null): TvVideoCapability[] {
  if (!raw || raw.length > 8192) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 5) return [];
    const seen = new Set<string>();
    return value.filter((entry): entry is TvVideoCapability => {
      if (!entry || !['h264', 'hevc', 'vp8', 'vp9', 'av1'].includes(entry.codec) || seen.has(entry.codec) ||
          !Number.isInteger(entry.width) || entry.width < 320 || entry.width > 3840 ||
          !Number.isInteger(entry.height) || entry.height < 240 || entry.height > 2160 ||
          !Array.isArray(entry.profiles) || entry.profiles.length > 12 ||
          !entry.profiles.every((profile: unknown) => typeof profile === 'string' && /^[a-z0-9 .-]{1,40}$/.test(profile))) return false;
      if (['h264', 'hevc'].includes(entry.codec) && !entry.profiles.length) return false;
      seen.add(entry.codec);
      return true;
    });
  } catch { return []; }
}
