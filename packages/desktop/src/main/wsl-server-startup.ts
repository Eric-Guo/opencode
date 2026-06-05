export function wslServerIdsToStartOnInitialize(servers: { id: string }[]) {
  return servers.map((server) => server.id)
}
