import { serve } from './http.mjs';
import { frame, inspection } from './frames.mjs';

export async function fixture(scenario = 'normal') {
  const calls = [];
  const source = await serve(async (request, response) => {
    const url = new URL(request.url, 'http://gateway'); calls.push(url.pathname);
    const data = [frame(0, inspection('I-1', 'pass', 'r1')), frame(0, inspection('I-2', '需复核', 'r1'))];
    const trailer = frame(128, Buffer.from(`grpc-status: ${scenario === 'failure' ? 13 : 0}\r\ngrpc-message: terminal\r\n`));
    let frames = scenario === 'no-trailer' ? data : [...data, trailer];
    if (scenario === 'after-trailer') frames = [...frames, data[0]];
    const text = scenario === 'text';
    response.writeHead(200, { 'content-type': text ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto' });
    const wire = text ? Buffer.from(frames.map(part => part.toString('base64')).join('')) : Buffer.concat(frames);
    for (let offset = 0; offset < wire.length; offset += 3) {
      response.write(wire.subarray(offset, offset + 3)); await new Promise(resolve => setImmediate(resolve));
    }
    response.end();
  });
  return { ...source, path: '/inspection/query', queryId: 'Q1', calls };
}
