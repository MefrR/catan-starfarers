import { networkInterfaces } from "node:os";

/** Adapter names that are usually virtual (Hyper-V / WSL / VPN / Docker). */
const VIRTUAL_NAME = /(vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier)/i;

/**
 * Best-guess LAN IPv4 address so the host can share a URL with the table.
 * Prefers real home/office ranges (192.168.* then 10.*) over the 172.16-31.*
 * range that Hyper-V/WSL virtual switches typically occupy, and deprioritizes
 * interfaces with virtual-sounding names.
 */
export function getLanAddress(): string {
  const nets = networkInterfaces();
  const candidates: { address: string; virtual: boolean; rank: number }[] = [];

  for (const name of Object.keys(nets)) {
    const virtual = VIRTUAL_NAME.test(name);
    for (const net of nets[name] ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      let rank = 9;
      if (net.address.startsWith("192.168.")) rank = 0;
      else if (net.address.startsWith("10.")) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) rank = 2;
      candidates.push({ address: net.address, virtual, rank });
    }
  }

  candidates.sort((a, b) => {
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1; // real adapters first
    return a.rank - b.rank; // then by range preference
  });

  return candidates[0]?.address ?? "localhost";
}
