import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import * as path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ARCHIVE_LIMITS, type ArchiveContents, type TarEntry } from './types';
import { parsePaxRecords, parseTarHeader } from './tarIndex';

interface ExtractHeader { name: string; size: number; type: string }
interface ExtractStream extends NodeJS.ReadableStream { resume(): this }
interface Extractor extends NodeJS.WritableStream {
  on(event: 'entry', listener: (header: ExtractHeader, stream: ExtractStream, next: (error?: Error) => void) => void): this;
}

// tar-stream has no bundled TypeScript declarations.
const tarStream = require('tar-stream') as { extract(): Extractor };

class TarHeaderGuard extends Transform {
  private header = Buffer.alloc(0);
  private remainingData = 0;
  private remainingContent = 0;
  private entries = 0;
  private expandedBytes = 0;
  private pathBytes = 0;
  private extensionType: 'x' | 'g' | undefined;
  private extensionChunks: Buffer[] = [];
  private localPaxSize: number | undefined;

  private finishEntry(): void {
    if (this.extensionType) {
      const records = parsePaxRecords(Buffer.concat(this.extensionChunks));
      const value = records.get('size');
      if (value !== undefined) {
        if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid PAX size: ${JSON.stringify(value)}`);
        const size = Number(value);
        if (!Number.isSafeInteger(size)) throw new Error('PAX size exceeds safe integer range');
        if (this.extensionType === 'g') throw new Error('Global PAX size overrides are not supported');
        this.localPaxSize = size;
      }
    }
    this.extensionType = undefined;
    this.extensionChunks = [];
    this.remainingContent = 0;
  }

  override _transform(chunk: Buffer | Uint8Array, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.expandedBytes += chunk.byteLength;
      if (this.expandedBytes > ARCHIVE_LIMITS.maxExpandedBytes) {
        throw new Error(`Expanded archive exceeds ${ARCHIVE_LIMITS.maxExpandedBytes} bytes`);
      }
      let input = Buffer.from(chunk);
      while (input.length) {
        if (this.remainingData > 0) {
          const length = Math.min(this.remainingData, input.length);
          const data = input.subarray(0, length);
          if (this.extensionType && this.remainingContent > 0) {
            const contentLength = Math.min(this.remainingContent, data.length);
            this.extensionChunks.push(Buffer.from(data.subarray(0, contentLength)));
            this.remainingContent -= contentLength;
          }
          this.push(data);
          this.remainingData -= length;
          input = input.subarray(length);
          if (this.remainingData === 0) this.finishEntry();
          continue;
        }
        const length = Math.min(512 - this.header.length, input.length);
        this.header = Buffer.concat([this.header, input.subarray(0, length)]);
        input = input.subarray(length);
        if (this.header.length < 512) continue;
        const parsed = parseTarHeader(this.header);
        if (parsed) {
          this.entries++;
          if (this.entries > ARCHIVE_LIMITS.maxEntries) {
            throw new Error(`Archive has more than ${ARCHIVE_LIMITS.maxEntries} entries`);
          }
          if ((parsed.type === 'L' || parsed.type === 'x' || parsed.type === 'g') && parsed.size > ARCHIVE_LIMITS.maxPathBytes) {
            throw new Error('PAX/GNU path header exceeds the configured limit');
          }
          if (parsed.type === 'L' || parsed.type === 'x' || parsed.type === 'g') {
            this.pathBytes += parsed.size;
            if (this.pathBytes > ARCHIVE_LIMITS.maxPathTotalBytes) {
              throw new Error('Archive paths exceed the cumulative limit');
            }
          }
          if (parsed.type === 'x' || parsed.type === 'g') {
            this.extensionType = parsed.type;
            this.remainingContent = parsed.size;
          }
          const regular = parsed.type === '\0' || parsed.type === '0' || parsed.type === '';
          const effectiveSize = regular ? (this.localPaxSize ?? parsed.size) : parsed.size;
          if (regular) this.localPaxSize = undefined;
          this.remainingData = Math.ceil(effectiveSize / 512) * 512;
          if (this.remainingData === 0) this.finishEntry();
        }
        this.push(this.header);
        this.header = Buffer.alloc(0);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.header.length || this.remainingData) callback(new Error('Truncated tar stream'));
    else callback();
  }
}

export async function extractGzipArchive(
  archivePath: string,
  tempDirectory: string,
  maxCachedBytes = ARCHIVE_LIMITS.maxCachedBytes,
  isCurrent: () => boolean = () => true,
  onEntry?: (kind: 'audio' | 'json', entry: TarEntry, index: number) => void | Promise<void>,
): Promise<ArchiveContents> {
  await mkdir(tempDirectory, { recursive: true });
  const audio: TarEntry[] = [];
  const json: TarEntry[] = [];
  let entryCount = 0;
  let cachedBytes = 0;
  let pathBytes = 0;
  const extract = tarStream.extract();
  extract.on('entry', (header, stream, next) => {
    void (async () => {
      if (!isCurrent()) throw new Error('Archive extraction cancelled');
      entryCount++;
      if (entryCount > ARCHIVE_LIMITS.maxEntries) throw new Error(`Archive has more than ${ARCHIVE_LIMITS.maxEntries} entries`);
      if (!Number.isSafeInteger(header.size) || header.size < 0) {
        throw new Error(`Invalid archive entry size: ${header.name}`);
      }
      pathBytes += Buffer.byteLength(header.name);
      if (pathBytes > ARCHIVE_LIMITS.maxPathTotalBytes) throw new Error('Archive paths exceed the cumulative limit');
      const regular = header.type === 'file';
      if (!regular || header.size === 0) {
        stream.resume();
        return;
      }
      const audioEntry = /\.(mp3|wav|ogg|flac|m4a|aac|webm|wma|aiff|opus)$/i.test(header.name);
      const jsonEntry = /\.json$/i.test(header.name);
      if (audioEntry || jsonEntry) {
        cachedBytes += header.size;
        if (cachedBytes > maxCachedBytes) throw new Error(`Session archive cache exceeds ${ARCHIVE_LIMITS.maxCachedBytes} bytes`);
        const disk = await statfs(tempDirectory);
        const available = Number(disk.bavail) * Number(disk.bsize);
        const reserve = 256 * 1024 * 1024;
        if (!Number.isSafeInteger(available) || available < header.size + reserve) {
          throw new Error(`Not enough disk space to cache archive entry: ${header.name}`);
        }
        const entries = audioEntry ? audio : json;
        const extension = audioEntry ? 'audio' : 'json';
        const outputPath = path.join(tempDirectory, `${entries.length}.${extension}`);
        await pipeline(stream as NodeJS.ReadableStream, createWriteStream(outputPath, { flags: 'wx' }));
        entries.push({ name: header.name, offset: 0, size: header.size });
        if (onEntry) await onEntry(extension as 'audio' | 'json', entries[entries.length - 1], entries.length - 1);
      } else {
        stream.resume();
      }
    })().then(() => next(), error => next(error instanceof Error ? error : new Error(String(error))));
  });
  try {
    await pipeline(createReadStream(archivePath), createGunzip(), new TarHeaderGuard(), extract);
    return { audio, json, cachedBytes };
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}
