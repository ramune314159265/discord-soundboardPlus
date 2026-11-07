/** ギルド単位のWSルーム。 */
export class Hub {
  constructor() {
    /** @type {Map<string, Set<{ ws: import('ws').WebSocket, guildId: string, channelId: string, userId: string }>>} */
    this.rooms = new Map()
  }

  add(client) {
    let room = this.rooms.get(client.guildId)
    if (!room) this.rooms.set(client.guildId, (room = new Set()))
    room.add(client)
  }

  remove(client) {
    const room = this.rooms.get(client.guildId)
    if (!room) return
    room.delete(client)
    if (room.size === 0) this.rooms.delete(client.guildId)
  }

  size(guildId) {
    return this.rooms.get(guildId)?.size ?? 0
  }

  broadcast(guildId, message) {
    const room = this.rooms.get(guildId)
    if (!room) return
    const text = JSON.stringify(message)
    for (const client of room) {
      if (client.ws.readyState === 1) client.ws.send(text)
    }
  }

  /** 全ルームのクライアントを列挙する (ユーザー単位の配信用) */
  *clients() {
    for (const room of this.rooms.values()) yield* room
  }
}
