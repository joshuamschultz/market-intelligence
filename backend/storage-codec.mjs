import * as zlib from 'node:zlib';

export const preparedCodec = typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'gzip';

export function encodeStoredJson(value, codec = preparedCodec) {
  return compressStoredJson(JSON.stringify(value), codec);
}

export function compressStoredJson(json, codec = preparedCodec) {
  return compressStoredBytes(json, codec);
}

export function compressStoredBytes(bytes, codec = preparedCodec) {
  if (codec === 'gzip') return zlib.gzipSync(bytes, { level: 1 });
  if (codec === 'zstd' && preparedCodec === 'zstd') return zlib.zstdCompressSync(bytes, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 },
  });
  throw new TypeError(`Unsupported prepared data codec: ${codec}`);
}

export function decodeStoredJson(value) {
  return JSON.parse(typeof value === 'string' ? value : decompressStoredBytes(value));
}

export function decompressStoredBytes(value) {
  if (value[0] === 0x1f && value[1] === 0x8b) return zlib.gunzipSync(value);
  if (value[0] === 0x28 && value[1] === 0xb5 && value[2] === 0x2f && value[3] === 0xfd &&
      typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(value);
  throw new Error('Unsupported prepared data compression');
}
