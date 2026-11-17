import { networkInterfaces } from 'node:os';

function isPrivateIpv4(address) {
  return address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function localNetworkAddress() {
  const choices = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/virtual|vEthernet|wsl|docker|radmin|loopback/i.test(name)) continue;
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && isPrivateIpv4(address.address)) {
        const priority = address.address.startsWith('192.168.') ? 0 : address.address.startsWith('10.') ? 1 : 2;
        choices.push({ address: address.address, priority });
      }
    }
  }
  choices.sort((a, b) => a.priority - b.priority);
  return choices[0]?.address || null;
}

export function getShareOrigin(request) {
  const requestUrl = new URL(request.url);
  const host = request.headers.get('host') || requestUrl.host;
  const parsedHost = new URL(`${requestUrl.protocol}//${host}`);
  const hostname = parsedHost.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';

  if (!isLoopback) return parsedHost.origin;

  const lanAddress = localNetworkAddress();
  if (!lanAddress) return parsedHost.origin;
  const port = parsedHost.port ? `:${parsedHost.port}` : '';
  return `${requestUrl.protocol}//${lanAddress}${port}`;
}
