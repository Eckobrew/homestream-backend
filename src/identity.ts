import proxyaddr from 'proxy-addr';
import { isIP } from 'node:net';
import type { PeerIdentity } from './request-context';
const normalize = (ip: string) => ip.replace(/^::ffff:/i, '');
/** Resolve from the trusted end of XFF; never accept an arbitrary leftmost address. */
export function resolvePeer(socketIp: string, headers: Headers, trustedProxies: string[]): PeerIdentity {
  const peer = normalize(socketIp);
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'].some(name => headers.has(name));
  const trust = trustedProxies.length ? proxyaddr.compile(trustedProxies) : () => false;
  if (isIP(peer) && trust(peer, 0)) {
    const chain = (headers.get('x-forwarded-for') || '').split(',').map(ip => normalize(ip.trim()));
    if (!chain.length || chain.some(ip => !isIP(ip))) return { socketIp: peer, clientIp: '', direct: false };
    let address = peer;
    while (chain.length && trust(address, 0)) address = chain.pop()!;
    return { socketIp: peer, clientIp: address, direct: false };
  }
  // Forwarding headers on an untrusted peer cannot confer local access.
  return { socketIp: peer, clientIp: forwarded ? '' : peer, direct: !forwarded && Boolean(isIP(peer)) };
}
