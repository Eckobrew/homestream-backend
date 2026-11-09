import zlib from 'node:zlib';

export interface ExportifyTrack {
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  spotifyTrackId?: string;
  coverUrl?: string;
}

export interface ExportifyPlaylistFile {
  name: string;
  content: string;
}

/**
 * Checks if a string looks like an Exportify CSV.
 */
export function isExportifyCsv(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const firstLine = text.trim().split(/\r?\n/)[0].toLowerCase();
  return (
    (firstLine.includes('track uri') || firstLine.includes('track name') || firstLine.includes('artist name') || firstLine.includes('spotify:track:')) &&
    firstLine.includes(',')
  );
}

/**
 * Parses an Exportify CSV file into structured track objects.
 */
export function parseExportifyCsv(csvContent: string): ExportifyTrack[] {
  if (!csvContent || typeof csvContent !== 'string') return [];

  const content = csvContent.replace(/^\uFEFF/, ''); // strip BOM
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\r') {
        if (nextChar === '\n') i++;
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else if (char === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += char;
      }
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];

  // Parse header
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const titleIdx = headers.findIndex((h) => h === 'track name' || h === 'title' || h === 'name' || h === 'song');
  const artistIdx = headers.findIndex((h) => h === 'artist name(s)' || h === 'artist name' || h === 'artist(s)' || h === 'artist');
  const albumIdx = headers.findIndex((h) => h === 'album name' || h === 'album');
  const durationIdx = headers.findIndex((h) => h.includes('duration') || h === 'length');
  const uriIdx = headers.findIndex((h) => h.includes('track uri') || h === 'uri' || h === 'spotify uri');

  if (titleIdx === -1 && artistIdx === -1) {
    return [];
  }

  const tracks: ExportifyTrack[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || (row.length === 1 && !row[0].trim())) continue;

    const title = titleIdx !== -1 && row[titleIdx] ? row[titleIdx].trim() : '';
    const artist = artistIdx !== -1 && row[artistIdx] ? row[artistIdx].trim() : '';
    const album = albumIdx !== -1 && row[albumIdx] ? row[albumIdx].trim() : '';

    if (!title && !artist) continue;

    let durationSeconds = 0;
    if (durationIdx !== -1 && row[durationIdx]) {
      const parsedDur = parseFloat(row[durationIdx].replace(/[^0-9.]/g, ''));
      if (!isNaN(parsedDur)) {
        durationSeconds = parsedDur > 1000 ? Math.round(parsedDur / 1000) : Math.round(parsedDur);
      }
    }

    let spotifyTrackId: string | undefined;
    if (uriIdx !== -1 && row[uriIdx]) {
      const uri = row[uriIdx].trim();
      const match = uri.match(/spotify:track:([a-zA-Z0-9]+)/);
      if (match) {
        spotifyTrackId = match[1];
      } else if (/^[a-zA-Z0-9]{22}$/.test(uri)) {
        spotifyTrackId = uri;
      }
    }

    tracks.push({
      title: title || 'Unknown Title',
      artist: artist || 'Unknown Artist',
      album: album || 'Unknown Album',
      durationSeconds,
      spotifyTrackId,
    });
  }

  return tracks;
}

/**
 * Extracts all .csv files from an Exportify zip archive.
 */
export function parseExportifyZip(zipBuffer: Buffer): ExportifyPlaylistFile[] {
  const entries: ExportifyPlaylistFile[] = [];
  if (!zipBuffer || zipBuffer.length < 22) return entries;

  // Find End of Central Directory (EOCD)
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
    const cdCount = zipBuffer.readUInt16LE(eocdOffset + 10);
    let cur = cdOffset;
    for (let c = 0; c < cdCount && cur + 46 <= zipBuffer.length; c++) {
      if (zipBuffer.readUInt32LE(cur) !== 0x02014b50) break;
      const method = zipBuffer.readUInt16LE(cur + 10);
      const compSize = zipBuffer.readUInt32LE(cur + 20);
      const nameLen = zipBuffer.readUInt16LE(cur + 28);
      const extraLen = zipBuffer.readUInt16LE(cur + 30);
      const commentLen = zipBuffer.readUInt16LE(cur + 32);
      const localHeaderOffset = zipBuffer.readUInt32LE(cur + 42);

      const name = zipBuffer.slice(cur + 46, cur + 46 + nameLen).toString('utf8');
      cur += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/') || !name.toLowerCase().endsWith('.csv') || name.startsWith('__MACOSX/')) continue;

      if (localHeaderOffset + 30 <= zipBuffer.length && zipBuffer.readUInt32LE(localHeaderOffset) === 0x04034b50) {
        const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const compData = zipBuffer.slice(dataStart, dataStart + compSize);

        try {
          let content = '';
          if (method === 0) content = compData.toString('utf8');
          else if (method === 8) content = zlib.inflateRawSync(compData).toString('utf8');
          if (content) {
            const cleanName = name.split('/').pop()?.replace(/\.csv$/i, '') || name;
            entries.push({ name: cleanName, content });
          }
        } catch (err: any) {
          console.warn(`[exportify] Failed extracting ${name} from zip:`, err.message);
        }
      }
    }
  }

  return entries;
}
