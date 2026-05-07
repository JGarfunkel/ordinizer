'use strict';
// CJS shim for the entire @exodus/bytes namespace — replaces the pure-ESM
// package for Jest environments.  All sub-paths (@exodus/bytes/encoding-lite.js,
// /encoding.js, /utf8.js, /utf16.js, /single-byte.js, …) map here via
// moduleNameMapper.  Uses Node 20 built-in WHATWG encoding APIs.

const TextDecoder = globalThis.TextDecoder;
const TextEncoder = globalThis.TextEncoder;
const TextDecoderStream = globalThis.TextDecoderStream;
const TextEncoderStream = globalThis.TextEncoderStream;

// ── encoding-lite.js / encoding.js exports ────────────────────────────────

function getBOMEncoding(uint8Array) {
  if (uint8Array[0] === 0xfe && uint8Array[1] === 0xff) return 'UTF-16BE';
  if (uint8Array[0] === 0xff && uint8Array[1] === 0xfe) return 'UTF-16LE';
  if (uint8Array[0] === 0xef && uint8Array[1] === 0xbb && uint8Array[2] === 0xbf) return 'UTF-8';
  return null;
}

function labelToName(label) {
  if (!label) return null;
  try {
    const enc = new TextDecoder(label).encoding;
    const map = {
      'utf-8': 'UTF-8',
      'utf-16be': 'UTF-16BE',
      'utf-16le': 'UTF-16LE',
      'windows-1252': 'windows-1252',
      'iso-8859-1': 'windows-1252',
    };
    return map[enc] ?? enc;
  } catch {
    return null;
  }
}

function normalizeEncoding(label) {
  if (!label) return null;
  try { return new TextDecoder(label).encoding; } catch { return null; }
}

function isomorphicDecode(uint8Array) {
  let result = '';
  for (let i = 0; i < uint8Array.length; i++) result += String.fromCharCode(uint8Array[i]);
  return result;
}

function isomorphicEncode(str) {
  const result = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) result[i] = str.charCodeAt(i) & 0xff;
  return result;
}

function legacyHookDecode(uint8Array, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(uint8Array);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(uint8Array);
  }
}

// ── utf8.js exports ───────────────────────────────────────────────────────

function utf8toString(uint8Array) {
  return new TextDecoder('utf-8').decode(uint8Array);
}
const utf8toStringLoose = utf8toString;
function utf8fromStringLoose(str) {
  return new TextEncoder().encode(str);
}

// ── utf16.js exports ──────────────────────────────────────────────────────

function utf16toString(uint8Array, littleEndian = true) {
  return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be').decode(uint8Array);
}
const utf16toStringLoose = utf16toString;

// ── single-byte.js exports ────────────────────────────────────────────────

function latin1toString(uint8Array) {
  return isomorphicDecode(uint8Array);
}
function latin1fromString(str) {
  return isomorphicEncode(str);
}
function createSinglebyteDecoder(/* label */) {
  return { decode: (uint8Array) => latin1toString(uint8Array) };
}

module.exports = {
  // encoding-lite / encoding
  TextDecoder,
  TextEncoder,
  TextDecoderStream,
  TextEncoderStream,
  getBOMEncoding,
  labelToName,
  normalizeEncoding,
  isomorphicDecode,
  isomorphicEncode,
  legacyHookDecode,
  // utf8
  utf8toString,
  utf8toStringLoose,
  utf8fromStringLoose,
  // utf16
  utf16toString,
  utf16toStringLoose,
  // single-byte
  latin1toString,
  latin1fromString,
  createSinglebyteDecoder,
};
