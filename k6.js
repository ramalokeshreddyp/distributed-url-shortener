import http from 'k6/http';
import { check, sleep } from 'k6';

// Benchmark options: Ramp up, hold, and ramp down
export const options = {
  stages: [
    { duration: '15s', target: 50 }, // ramp up to 50 concurrent users
    { duration: '30s', target: 50 }, // run at 50 users
    { duration: '15s', target: 0 },  // scale down
  ],
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const STRATEGY = __ENV.STRATEGY || 'hash';

// Pre-populate some short URLs in the setup phase to test cache hits
export function setup() {
  const shortCodes = [];
  console.log(`Setting up benchmark test with strategy: ${STRATEGY} against: ${BASE_URL}`);
  
  for (let i = 0; i < 20; i++) {
    const res = http.post(`${BASE_URL}/api/shorten`, JSON.stringify({
      url: `https://example.com/popular-link-${i}-${Math.random()}`,
      strategy: STRATEGY
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (res.status === 201) {
      try {
        const data = JSON.parse(res.body);
        const parts = data.short_url.split('/');
        shortCodes.push(parts[parts.length - 1]);
      } catch (e) {
        console.error('Failed to parse shorten response during setup:', res.body);
      }
    } else {
      console.error(`Failed to pre-create short code during setup. Status: ${res.status}`);
    }
  }
  
  console.log(`Successfully pre-populated ${shortCodes.length} URLs for caching test.`);
  return { shortCodes };
}

export default function (data) {
  const { shortCodes } = data;
  
  // 80% read requests (GET /:shortCode), 20% write requests (POST /api/shorten)
  const rand = Math.random();
  
  if (rand < 0.8 && shortCodes.length > 0) {
    // Read load: pick a random short code from the popular ones
    const code = shortCodes[Math.floor(Math.random() * shortCodes.length)];
    const res = http.get(`${BASE_URL}/${code}`, {
      redirects: 0, // Do not follow the 302 redirect, check redirect performance
    });
    
    check(res, {
      'redirect is 302': (r) => r.status === 302,
      'has Location header': (r) => r.headers['Location'] !== undefined,
      'has X-Cache-Status': (r) => r.headers['X-Cache-Status'] !== undefined,
      'cache hit or miss': (r) => r.headers['X-Cache-Status'] === 'HIT' || r.headers['X-Cache-Status'] === 'MISS',
    });
  } else {
    // Write load: shorten a new random URL
    const url = `https://example.com/new-link-${Math.random()}`;
    const payload = JSON.stringify({
      url: url,
      strategy: STRATEGY,
    });
    
    const res = http.post(`${BASE_URL}/api/shorten`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
    
    check(res, {
      'shorten is 201': (r) => r.status === 201,
      'has short_url': (r) => {
        try {
          return JSON.parse(r.body).short_url !== undefined;
        } catch (e) {
          return false;
        }
      },
    });
  }
  
  sleep(0.1); // Small sleep between iterations
}
