export const maxActiveRooms = 100;
const reservationTimeout = 60000;

export class RoomCapacity {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_capacity (room_id TEXT PRIMARY KEY, token TEXT NOT NULL, reserved_until INTEGER)');
  }

  acquire(roomId, now, reserve = false) {
    return this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM room_capacity WHERE reserved_until IS NOT NULL AND reserved_until <= ?', now);
      const existing = this.sql.exec('SELECT token, reserved_until FROM room_capacity WHERE room_id = ?', roomId).toArray()[0];
      if (existing) {
        if (reserve) return { collision: true };
        if (existing.reserved_until !== null) this.sql.exec('UPDATE room_capacity SET reserved_until = NULL WHERE room_id = ?', roomId);
        return { token: existing.token };
      }
      if (this.sql.exec('SELECT COUNT(*) AS count FROM room_capacity').toArray()[0].count >= maxActiveRooms) return null;
      const token = crypto.randomUUID();
      this.sql.exec('INSERT INTO room_capacity(room_id, token, reserved_until) VALUES (?, ?, ?)', roomId, token, reserve ? now + reservationTimeout : null);
      return { token };
    });
  }

  release(roomId, token = null) {
    if (token === null) this.sql.exec('DELETE FROM room_capacity WHERE room_id = ?', roomId);
    else this.sql.exec('DELETE FROM room_capacity WHERE room_id = ? AND token = ?', roomId, token);
  }
}
