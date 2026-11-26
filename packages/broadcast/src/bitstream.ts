// H.264 as Mediabunny's encoders give it (AVCC: each NAL unit prefixed by its length, the parameter sets in the
// decoder config's `avcC` description) rewritten as Annex B (each NAL unit after a start code, the parameter sets
// in-band before every keyframe): what a reader configured without a description decodes, and what joining at any
// keyframe needs. A copy per frame, of bytes already in memory: nothing is decoded.

const START_CODE = new Uint8Array([0, 0, 0, 1]);

/** An `avcC` record's parameter sets and NAL length size. */
export interface AvcParameters {
  lengthSize: number;
  /** The SPS and PPS NAL units, in order. */
  parameterSets: Uint8Array[];
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return new Uint8Array(source);
}

/**
 * Read an `avcC` record (ISO/IEC 14496-15, 5.3.3.1); undefined if it is not one. After a five-byte header come the
 * SPS units and then the PPS units, each list a count and then length-prefixed units; any length running past the
 * end means it is not a record after all.
 */
export function parseAvcC(description: AllowSharedBufferSource): AvcParameters | undefined {
  const bytes = bytesOf(description);
  if (bytes.length < 7 || bytes[0] !== 1) return undefined;
  const lengthSize = (bytes[4]! & 0b11) + 1;
  const parameterSets: Uint8Array[] = [];
  let offset = 5;
  // The SPS count is the low five bits of byte 5; the PPS count is a whole byte after them.
  for (const countMask of [0b1_1111, 0xff]) {
    // A count, then that many units of a two-byte length and its bytes; a list past the end is no record.
    if (offset >= bytes.length) return undefined;
    const count = bytes[offset]! & countMask;
    offset += 1;
    for (let index = 0; index < count; index += 1) {
      if (offset + 2 > bytes.length) return undefined;
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      offset += 2;
      if (offset + length > bytes.length) return undefined;
      parameterSets.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
  }
  return { lengthSize, parameterSets };
}

/** One AVCC frame as Annex B, with the parameter sets before it when it is a keyframe. */
export function avccToAnnexB(frame: Uint8Array, parameters: AvcParameters, keyframe: boolean): Uint8Array {
  const units: Uint8Array[] = keyframe ? [...parameters.parameterSets] : [];
  const { lengthSize } = parameters;
  let offset = 0;
  while (offset + lengthSize <= frame.length) {
    let length = 0;
    for (let index = 0; index < lengthSize; index += 1) length = length * 256 + frame[offset + index]!;
    offset += lengthSize;
    if (length === 0 || offset + length > frame.length) break;
    units.push(frame.subarray(offset, offset + length));
    offset += length;
  }
  const size = units.reduce((total, unit) => total + START_CODE.length + unit.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const unit of units) {
    out.set(START_CODE, at);
    out.set(unit, at + START_CODE.length);
    at += START_CODE.length + unit.length;
  }
  return out;
}
