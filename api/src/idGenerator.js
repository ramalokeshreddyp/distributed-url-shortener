import crypto from 'crypto';

const BASE62_CHARSET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Base62 encoding for BigInt
export function encodeBase62(value) {
  if (value === 0n) return BASE62_CHARSET[0];
  let result = '';
  let temp = value;
  while (temp > 0n) {
    const remainder = Number(temp % 62n);
    result = BASE62_CHARSET[remainder] + result;
    temp = temp / 62n;
  }
  return result;
}

// Generate short code based on URL hashing
export function generateHashId(url, attempt = 0) {
  // Add attempt index to handle DB collision by generating a different hash on retry
  const salt = attempt > 0 ? `:${attempt}` : '';
  const hash = crypto.createHash('md5').update(url + salt).digest();
  
  // Extract the first 6 bytes (48 bits)
  const firstBytes = hash.subarray(0, 6);
  const bigIntValue = BigInt('0x' + firstBytes.toString('hex'));
  
  // Base62 encode the BigInt
  return encodeBase62(bigIntValue);
}

// Snowflake-inspired 64-bit ID generator
class SnowflakeGenerator {
  constructor(nodeId = 1) {
    // 10 bits node ID (0 - 1023)
    this.nodeId = BigInt(nodeId) & 1023n;
    // Custom epoch: 2026-01-01T00:00:00Z (1767225600000 ms)
    this.epoch = 1767225600000n;
    this.sequence = 0n;
    this.lastTimestamp = -1n;
  }

  nextId() {
    let timestamp = BigInt(Date.now());

    if (timestamp < this.lastTimestamp) {
      throw new Error(`Clock moved backwards. Rejecting requests for ${this.lastTimestamp - timestamp}ms`);
    }

    if (timestamp === this.lastTimestamp) {
      // 12 bits sequence number (0 - 4095)
      this.sequence = (this.sequence + 1n) & 4095n;
      if (this.sequence === 0n) {
        // Sequence overflow in the same millisecond, wait for next ms
        while (timestamp <= this.lastTimestamp) {
          timestamp = BigInt(Date.now());
        }
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const timeDiff = timestamp - this.epoch;
    
    // Structure: 1 sign bit (0) | 41 bits timestamp | 10 bits node_id | 12 bits sequence
    const id = (timeDiff << 22n) | (this.nodeId << 12n) | this.sequence;
    return id;
  }

  generateId() {
    const id = this.nextId();
    return encodeBase62(id);
  }
}

// Read NODE_ID from env
const nodeId = process.env.NODE_ID ? parseInt(process.env.NODE_ID, 10) : 1;
const snowflakeGenerator = new SnowflakeGenerator(nodeId);

export function generateSnowflakeId() {
  return snowflakeGenerator.generateId();
}
