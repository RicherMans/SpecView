import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { ARCHIVE_LIMITS, type ArchiveContents, type TarEntry } from './types';

const BLOCK = 512;

function fieldText(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.toString('utf8', start, end >= start && end < start + length ? end : start + length).trim();
}

export function parseTarNumber(field: Uint8Array): number {
  if (field.length === 0) throw new Error('Empty tar number');
  if ((field[0] & 0x80) !== 0) {
    if ((field[0] & 0x40) !== 0) throw new Error('Negative tar number');
    let value = BigInt(field[0] & 0x7f);
    for (let i = 1; i < field.length; i++) value = (value << 8n) | BigInt(field[i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Tar number exceeds safe integer range');
    return Number(value);
  }
  const text = Buffer.from(field).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid tar octal number: ${JSON.stringify(text)}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error('Tar number exceeds safe integer range');
  return value;
}

export interface ParsedTarHeader {
  name: string;
  size: number;
  type: string;
}

export function parseTarHeader(block: Uint8Array): ParsedTarHeader | undefined {
  if (block.byteLength !== BLOCK) throw new Error('Tar header must be 512 bytes');
  const header = Buffer.from(block.buffer, block.byteOffset, block.byteLength);
  if (header.every(byte => byte === 0)) return undefined;
  const storedChecksum = parseTarNumber(header.subarray(148, 156));
  let checksum = 0;
  for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (checksum !== storedChecksum) throw new Error(`Invalid tar checksum (expected ${storedChecksum}, got ${checksum})`);
  const name = fieldText(header, 0, 100);
  const magic = header.toString('latin1', 257, 263);
  const prefix = magic === 'ustar\0' ? fieldText(header, 345, 155) : '';
  const size = parseTarNumber(header.subarray(124, 136));
  return { name: prefix ? `${prefix}/${name}` : name, size, type: String.fromCharCode(header[156] || 0) };
}

export function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.byteLength) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('Invalid PAX record length');
    const lengthText = Buffer.from(data.subarray(offset, space)).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('Invalid PAX record length');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.byteLength) {
      throw new Error('PAX record exceeds entry size');
    }
    const record = Buffer.from(data.subarray(space + 1, offset + length));
    if (record[record.length - 1] !== 0x0a) throw new Error('PAX record is not newline terminated');
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error('Invalid PAX key/value record');
    records.set(record.toString('utf8', 0, equals), record.toString('utf8', equals + 1, record.length - 1));
    offset += length;
  }
  return records;
}

async function readExact(handle: FileHandle, size: number, position: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const result = await handle.read(data, read, size - read, position + read);
    if (result.bytesRead === 0) throw new Error(`Unexpected end of tar at offset ${position + read}`);
    read += result.bytesRead;
  }
  return data;
}

export async function indexTarFile(filePath: string, isCurrent: () => boolean = () => true): Promise<ArchiveContents> {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!Number.isSafeInteger(stat.size)) throw new Error('Tar file is too large to index safely');
    const audio: TarEntry[] = [];
    const json: TarEntry[] = [];
    let offset = 0;
    let entryCount = 0;
    let pathBytes = 0;
    let longName: string | undefined;
    const globalPax = new Map<string, string>();
    let localPax = new Map<string, string>();
    while (offset + BLOCK <= stat.size) {
      if (!isCurrent()) throw new Error('Archive indexing cancelled');
      const header = parseTarHeader(await readExact(handle, BLOCK, offset));
      if (!header) break;
      entryCount++;
      if (entryCount > ARCHIVE_LIMITS.maxEntries) throw new Error(`Archive has more than ${ARCHIVE_LIMITS.maxEntries} entries`);
      const dataOffset = offset + BLOCK;
      let physicalSize = header.size;
      if (header.type === 'L') {
        if (header.size > ARCHIVE_LIMITS.maxPathBytes) throw new Error('GNU longname is too large');
        pathBytes += header.size;
        if (pathBytes > ARCHIVE_LIMITS.maxPathTotalBytes) throw new Error('Archive paths exceed the cumulative limit');
        longName = (await readExact(handle, header.size, dataOffset)).toString('utf8').replace(/\0.*$/, '').replace(/\n$/, '');
      } else if (header.type === 'x' || header.type === 'g') {
        if (header.size > ARCHIVE_LIMITS.maxPathBytes) throw new Error('PAX header is too large');
        pathBytes += header.size;
        if (pathBytes > ARCHIVE_LIMITS.maxPathTotalBytes) throw new Error('Archive paths exceed the cumulative limit');
        const records = parsePaxRecords(await readExact(handle, header.size, dataOffset));
        if (header.type === 'g') {
          for (const [key, value] of records) globalPax.set(key, value);
        } else {
          localPax = records;
        }
      } else {
        const attributes = new Map(globalPax);
        for (const [key, value] of localPax) attributes.set(key, value);
        const name = attributes.get('path') ?? longName ?? header.name;
        pathBytes += Buffer.byteLength(name);
        if (pathBytes > ARCHIVE_LIMITS.maxPathTotalBytes) throw new Error('Archive paths exceed the cumulative limit');
        const paxSize = attributes.get('size');
        if (paxSize !== undefined) {
          if (!/^[0-9]+$/.test(paxSize)) throw new Error(`Invalid PAX size: ${JSON.stringify(paxSize)}`);
          physicalSize = Number(paxSize);
          if (!Number.isSafeInteger(physicalSize)) throw new Error('PAX size exceeds safe integer range');
        }
        localPax = new Map();
        longName = undefined;
        const regular = header.type === '\0' || header.type === '0' || header.type === '';
        if (regular && physicalSize > 0) {
          if (/\.(mp3|wav|ogg|flac|m4a|aac|webm|wma|aiff|opus)$/i.test(name)) {
            audio.push({ name, offset: dataOffset, size: physicalSize });
          } else if (/\.json$/i.test(name)) {
            json.push({ name, offset: dataOffset, size: physicalSize });
          }
        }
      }
      const padded = Math.ceil(physicalSize / BLOCK) * BLOCK;
      const nextOffset = dataOffset + padded;
      if (!Number.isSafeInteger(nextOffset) || dataOffset + physicalSize > stat.size || nextOffset > stat.size) {
        throw new Error(`Archive entry at ${offset} exceeds file size`);
      }
      offset = nextOffset;
    }
    return { audio, json, cachedBytes: 0 };
  } finally {
    await handle.close();
  }
}
